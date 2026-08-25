import { describe, it, expect } from 'bun:test';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { makeRequestTiming } from '../../../src/middlewares/requestTiming';
import { errorHandler } from '../../../src/middlewares/errorHandler';
import { createLogger, createRecentLogStore, type RecentLogEntry } from '../../../src/utils/logger';
import { createRequestMetricsStore } from '../../../src/utils/performanceMetrics';
import { AppError } from '../../../src/utils/AppError';

/** A logger whose records land in a buffer instead of the test runner's output. */
const createTestLogger = () => {
  const store = createRecentLogStore({ capacity: 50 });
  const logger = createLogger({
    level: 'info',
    pretty: false,
    store,
    stdout: { write: () => true } as unknown as NodeJS.WritableStream,
  });
  return {
    logger,
    requests: (): RecentLogEntry[] =>
      store.recent().filter((entry) => entry.msg === 'request completed'),
  };
};

/**
 * A clock that advances by a fixed amount on every read, so a handler's measured
 * duration is exact rather than whatever the machine happened to take.
 */
const stepClock = (stepMs: number) => {
  let current = 0;
  return () => {
    const value = current;
    current += stepMs;
    return value;
  };
};

describe('requestTiming middleware', () => {
  it('logs method, path, status and a numeric duration for a served request', async () => {
    const { logger, requests } = createTestLogger();
    const metrics = createRequestMetricsStore({ sampleCapacity: 10 });

    const app = new Hono();
    app.use('*', makeRequestTiming({ logger, metrics, now: stepClock(12.5) }));
    app.get('/api/v1/health', (c) => c.json({ status: 'ok' }, 200));

    const response = await app.request('/api/v1/health');
    expect(response.status).toBe(200);

    const [entry] = requests();
    expect(entry).toMatchObject({
      method: 'GET',
      path: '/api/v1/health',
      status: 200,
      durationMs: 12.5,
    });
    expect(typeof entry.durationMs).toBe('number');
  });

  it('updates the metrics aggregate with the observed request', async () => {
    const { logger } = createTestLogger();
    const metrics = createRequestMetricsStore({ sampleCapacity: 10 });

    const app = new Hono();
    app.use('*', makeRequestTiming({ logger, metrics, now: stepClock(4) }));
    app.get('/api/v1/rooms', (c) => c.json([], 200));

    await app.request('/api/v1/rooms');
    await app.request('/api/v1/rooms');

    const snapshot = metrics.snapshot();
    expect(snapshot.totalRequests).toBe(2);
    expect(snapshot.statusClasses['2xx']).toBe(2);
    expect(snapshot.latency.count).toBe(2);
    expect(snapshot.latency.maxMs).toBe(4);
  });

  it('records the status a thrown AppError will produce, and re-throws it', async () => {
    const { logger, requests } = createTestLogger();
    const metrics = createRequestMetricsStore({ sampleCapacity: 10 });

    const app = new Hono();
    app.onError(errorHandler);
    app.use('*', makeRequestTiming({ logger, metrics, now: stepClock(7) }));
    app.get('/api/v1/rooms/:id', () => {
      throw new AppError(403, 'Forbidden', 'FORBIDDEN');
    });

    const response = await app.request('/api/v1/rooms/1');
    expect(response.status).toBe(403);

    expect(requests()[0]).toMatchObject({ status: 403, durationMs: 7, level: 30 });
    expect(metrics.snapshot().statusClasses['4xx']).toBe(1);
  });

  it('records an unexpected throw as the 500 the caller receives, at warn level', async () => {
    const { logger, requests } = createTestLogger();
    const metrics = createRequestMetricsStore({ sampleCapacity: 10 });

    const app = new Hono();
    app.onError(errorHandler);
    app.use('*', makeRequestTiming({ logger, metrics, now: stepClock(3) }));
    app.get('/boom', () => {
      throw new Error('kaboom');
    });

    const response = await app.request('/boom');
    expect(response.status).toBe(500);

    // pino's numeric levels: 40 is warn, so a 5xx rises above the info floor.
    expect(requests()[0]).toMatchObject({ status: 500, level: 40 });
    expect(metrics.snapshot().statusClasses['5xx']).toBe(1);
  });

  it('leaves skipped requests out of both the log and the aggregate', async () => {
    const { logger, requests } = createTestLogger();
    const metrics = createRequestMetricsStore({ sampleCapacity: 10 });

    const app = new Hono();
    app.use(
      '*',
      makeRequestTiming({
        logger,
        metrics,
        now: stepClock(1),
        skip: (c) => c.req.path === '/api/v1/health',
      }),
    );
    app.get('/api/v1/health', (c) => c.json({ status: 'ok' }, 200));
    app.get('/api/v1/rooms', (c) => c.json([], 200));

    await app.request('/api/v1/health');
    await app.request('/api/v1/rooms');

    expect(requests()).toHaveLength(1);
    expect(requests()[0]?.path).toBe('/api/v1/rooms');
    expect(metrics.snapshot().totalRequests).toBe(1);
  });

  /**
   * `cors()` answers an `OPTIONS` preflight with its own 204 and never calls
   * `next()`, so this is the ordering that decides whether preflight traffic
   * appears in the metrics at all. Exercised against the real CORS middleware
   * rather than a stand-in: the behaviour under test is Hono's, and a fake would
   * keep passing if Hono ever changed it.
   */
  it('measures a CORS preflight that never reaches a route', async () => {
    const { logger, requests } = createTestLogger();
    const metrics = createRequestMetricsStore({ sampleCapacity: 10 });

    const app = new Hono();
    app.use('*', makeRequestTiming({ logger, metrics, now: stepClock(2) }));
    app.use('*', cors({ origin: 'https://app.example', credentials: true }));
    app.post('/api/v1/rooms', (c) => c.json({ ok: true }, 201));

    const response = await app.request('/api/v1/rooms', {
      method: 'OPTIONS',
      headers: {
        origin: 'https://app.example',
        'Access-Control-Request-Method': 'POST',
      },
    });
    expect(response.status).toBe(204);

    expect(requests()[0]).toMatchObject({ method: 'OPTIONS', path: '/api/v1/rooms', status: 204 });
    expect(metrics.snapshot().totalRequests).toBe(1);
  });

  it('does not log credentials carried on the timed request', async () => {
    const { logger, requests } = createTestLogger();
    const metrics = createRequestMetricsStore({ sampleCapacity: 10 });

    const app = new Hono();
    app.use('*', makeRequestTiming({ logger, metrics, now: stepClock(1) }));
    app.get('/api/v1/users/me', (c) => c.json({ ok: true }, 200));

    await app.request('/api/v1/users/me', {
      headers: { authorization: 'Bearer super-secret-token', cookie: 'access_token=secret' },
    });

    expect(JSON.stringify(requests())).not.toContain('secret');
  });
});
