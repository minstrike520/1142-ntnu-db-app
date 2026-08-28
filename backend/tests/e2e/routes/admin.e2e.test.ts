import type { Hono } from 'hono';
import { describe, it, expect, beforeAll, beforeEach } from 'bun:test';
import { request } from '../../helpers/http';
import { resetDb } from '../../helpers/resetDb';
import type { AdminHealthResponse, AuthResponse, AdminLogsResponse, AdminMetricsResponse, AdminSlowQueriesResponse } from '../../helpers/responseTypes';
import { testPool } from '../../helpers/testPool';
import { createLogger, recentLogs } from '../../../src/utils/logger';
import { slowQueries } from '../../../src/utils/slowQueryStore';

let app: Hono;

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;
  const indexModule = await import('../../../src/index');
  app = indexModule.honoApp;
});

const registerUser = async (email: string): Promise<{ token: string; userId: string }> => {
  const res = await request(app).post<AuthResponse>('/api/v1/auth/register').send({
    name: 'Admin Gate User',
    email,
    password: 'Password123!',
  });
  if (res.status !== 201) throw new Error('REGISTER FAILED: ' + JSON.stringify(res.body));
  return { token: res.body.token, userId: res.body.user.userId };
};

/**
 * Promotion is a direct DB write on purpose: `is_admin` is absent from the
 * repository's `update` allow-list, so there is no HTTP path that grants it.
 * This mirrors the documented bootstrap in docs/DEVELOPMENT.md.
 */
const promote = async (userId: string): Promise<void> => {
  await testPool`UPDATE users SET is_admin = true WHERE user_id = ${userId}`;
};

describe('Admin gate E2E', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('rejects an unauthenticated request with 401', async () => {
    const res = await request(app).get<AdminHealthResponse>('/api/v1/admin/health');
    expect(res.status).toBe(401);
  });

  it('rejects an authenticated non-admin with 403', async () => {
    const { token } = await registerUser('plain@example.com');

    const res = await request(app)
      .get<AdminHealthResponse>('/api/v1/admin/health')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
  });

  it('allows a user whose row has is_admin = true', async () => {
    const { token, userId } = await registerUser('admin@example.com');
    await promote(userId);

    const res = await request(app)
      .get<AdminHealthResponse>('/api/v1/admin/health')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('newly registered accounts are not admins', async () => {
    const { userId } = await registerUser('default@example.com');

    const [row] = await testPool`SELECT is_admin FROM users WHERE user_id = ${userId}`;

    expect(row.is_admin).toBe(false);
  });

  it('revoking is_admin takes effect on the very next request, without a new token', async () => {
    const { token, userId } = await registerUser('revoked@example.com');
    await promote(userId);

    const allowed = await request(app)
      .get<AdminHealthResponse>('/api/v1/admin/health')
      .set('Authorization', `Bearer ${token}`);
    expect(allowed.status).toBe(200);

    await testPool`UPDATE users SET is_admin = false WHERE user_id = ${userId}`;

    const denied = await request(app)
      .get<AdminHealthResponse>('/api/v1/admin/health')
      .set('Authorization', `Bearer ${token}`);
    expect(denied.status).toBe(403);
  });

  it('does not let a soft-deleted admin through', async () => {
    const { token, userId } = await registerUser('deleted@example.com');
    await promote(userId);
    await testPool`UPDATE users SET deleted_at = NOW() WHERE user_id = ${userId}`;

    const res = await request(app)
      .get<AdminHealthResponse>('/api/v1/admin/health')
      .set('Authorization', `Bearer ${token}`);

    // authMiddleware rejects the deleted account first; the admin gate is a
    // second, independent soft-delete filter behind it.
    expect(res.status).toBe(401);
  });
});

/**
 * The monitoring endpoints render three process-wide buffers, and under the test
 * runner two of them are empty: `LOG_LEVEL` defaults to `silent`, so pino writes
 * no records, and nothing in a test run is slow enough to be a slow query. An
 * earlier version of this suite asserted against those empty arrays and passed
 * even when `/logs` ignored `?limit=` entirely — so each buffer is seeded here
 * with records the assertions can actually bite on.
 *
 * Seeding the real buffers rather than injecting fakes is deliberate: these are
 * the exact objects the running app hands the route, so this covers the wiring
 * as well as the rendering. Both are bounded rings, so the handful of records
 * added here cannot grow anything.
 */
describe('Admin monitoring endpoints E2E', () => {
  const ENDPOINTS = ['/api/v1/admin/metrics', '/api/v1/admin/logs', '/api/v1/admin/slow-queries'];

  let adminToken: string;

  const seedLogs = (count: number): void => {
    for (let index = 0; index < count; index += 1) {
      recentLogs.push(
        JSON.stringify({ level: 30, time: Date.now() + index, msg: `seeded-record-${index}` }),
      );
    }
  };

  const seedSlowQueries = (count: number): void => {
    for (let index = 0; index < count; index += 1) {
      slowQueries.push({
        query: `SELECT * FROM seeded_table WHERE id = ? -- ${index}`,
        durationMs: 150 + index,
        at: Date.now() + index,
      });
    }
  };

  beforeEach(async () => {
    await resetDb();
    const { token, userId } = await registerUser('monitor-admin@example.com');
    await promote(userId);
    adminToken = token;
  });

  const asAdmin = <T>(path: string) =>
    request(app).get<T>(path).set('Authorization', `Bearer ${adminToken}`);

  it('refuses every endpoint without authentication', async () => {
    for (const path of ENDPOINTS) {
      expect((await request(app).get(path)).status).toBe(401);
    }
  });

  it('refuses every endpoint for an authenticated non-admin', async () => {
    const { token } = await registerUser('monitor-plain@example.com');

    for (const path of ENDPOINTS) {
      const res = await request(app).get<{ code: string }>(path).set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('FORBIDDEN');
    }
  });

  it('tells intermediaries never to cache a monitoring answer', async () => {
    // A stale 200 during an incident is indistinguishable from a system that
    // stopped changing.
    for (const path of ENDPOINTS) {
      expect((await asAdmin(path)).headers['cache-control']).toBe('no-store');
    }
  });

  it('reports request and process metrics', async () => {
    const res = await asAdmin<AdminMetricsResponse>('/api/v1/admin/metrics');

    expect(res.status).toBe(200);
    expect(res.body.requests.totalRequests).toBeGreaterThan(0);
    expect(res.body.requests.statusClasses['2xx']).toBeGreaterThan(0);
    expect(res.body.requests.latency).toMatchObject({
      count: expect.any(Number),
      avgMs: expect.any(Number),
      p50Ms: expect.any(Number),
      p95Ms: expect.any(Number),
      p99Ms: expect.any(Number),
      maxMs: expect.any(Number),
    });
    expect(res.body.process.memory.rssBytes).toBeGreaterThan(0);
    expect(res.body.process.uptimeSeconds).toBeGreaterThan(0);
    // Null on the first sample of a process, a number once there is an earlier
    // point to difference against — both are correct, neither is absent.
    expect(['number', 'object']).toContain(typeof res.body.process.cpu.percent);
    expect(res.body.at).toBeGreaterThan(0);
  });

  it('counts the failed admin attempts it just served', async () => {
    const before = (await asAdmin<AdminMetricsResponse>('/api/v1/admin/metrics')).body.requests.statusClasses['4xx'];
    await request(app).get('/api/v1/admin/metrics');

    const after = (await asAdmin<AdminMetricsResponse>('/api/v1/admin/metrics')).body.requests.statusClasses['4xx'];

    // Proves the endpoint reads the live buffer the timing middleware feeds,
    // rather than a snapshot taken at startup.
    expect(after).toBeGreaterThan(before);
  });

  it('returns the recent log buffer, oldest first', async () => {
    seedLogs(5);

    const res = await asAdmin<AdminLogsResponse>('/api/v1/admin/logs');

    expect(res.status).toBe(200);
    expect(res.body.retained).toBeGreaterThanOrEqual(5);
    expect(res.body.retained).toBeLessThanOrEqual(res.body.capacity);

    const seeded = res.body.entries.filter((entry: { msg?: string }) =>
      entry.msg?.startsWith('seeded-record-'),
    );
    expect(seeded.map((entry: { msg: string }) => entry.msg)).toEqual([
      'seeded-record-0',
      'seeded-record-1',
      'seeded-record-2',
      'seeded-record-3',
      'seeded-record-4',
    ]);
  });

  it('honours ?limit= and rejects one the buffer cannot satisfy', async () => {
    seedLogs(5);

    const full = await asAdmin<AdminLogsResponse>('/api/v1/admin/logs');
    const limited = await asAdmin<AdminLogsResponse>('/api/v1/admin/logs?limit=2');

    expect(limited.status).toBe(200);
    expect(limited.body.entries).toHaveLength(2);
    expect(full.body.entries.length).toBeGreaterThan(limited.body.entries.length);
    // The newest two, since the window ends at the most recent record.
    expect(limited.body.entries.map((entry: { msg: string }) => entry.msg)).toEqual([
      'seeded-record-3',
      'seeded-record-4',
    ]);
    expect(limited.body.capacity).toBe(full.body.capacity);

    expect((await asAdmin(`/api/v1/admin/logs?limit=${full.body.capacity + 1}`)).status).toBe(400);
    expect((await asAdmin('/api/v1/admin/logs?limit=0')).status).toBe(400);
    expect((await asAdmin('/api/v1/admin/logs?limit=all')).status).toBe(400);
  });

  it('never hands out a credential through the log buffer', async () => {
    // The buffer is served over HTTP, so pino's redaction is the only thing
    // between a logged field and an endpoint that returns it. Written through a
    // real logger at a real level, into the same process-wide store the route
    // reads, rather than pushed in pre-serialized — redaction happens on the way
    // in, so pushing a raw line would prove nothing.
    const noisy = createLogger({
      level: 'info',
      pretty: false,
      store: recentLogs,
      stdout: { write: () => true } as unknown as NodeJS.WritableStream,
    });
    noisy.info({ password: 'hunter2', refreshToken: 'rt-secret' }, 'seeded credential record');

    const res = await asAdmin<AdminLogsResponse>('/api/v1/admin/logs');

    const body = JSON.stringify(res.body);
    expect(body).toInclude('seeded credential record');
    expect(body).not.toInclude('hunter2');
    expect(body).not.toInclude('rt-secret');
    expect(body).toInclude('[redacted]');
  });

  it('returns the slow-query buffer with the threshold that defines it', async () => {
    seedSlowQueries(3);

    const res = await asAdmin<AdminSlowQueriesResponse>('/api/v1/admin/slow-queries');

    expect(res.status).toBe(200);
    expect(res.body.thresholdMs).toBeGreaterThan(0);
    expect(res.body.retained).toBeGreaterThanOrEqual(3);
    expect(res.body.retained).toBeLessThanOrEqual(res.body.capacity);

    const seeded = res.body.queries.filter((record: { query: string }) =>
      record.query.startsWith('SELECT * FROM seeded_table'),
    );
    expect(seeded).toHaveLength(3);
    for (const record of seeded) {
      expect(record.durationMs).toBeGreaterThanOrEqual(res.body.thresholdMs);
      expect(record.at).toBeGreaterThan(0);
    }

    const limited = await asAdmin<AdminSlowQueriesResponse>('/api/v1/admin/slow-queries?limit=1');
    expect(limited.body.queries).toHaveLength(1);
    expect((await asAdmin('/api/v1/admin/slow-queries?limit=0')).status).toBe(400);
  });
});
