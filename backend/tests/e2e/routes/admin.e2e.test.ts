import { describe, it, expect, beforeAll, beforeEach } from 'bun:test';
import request from 'supertest';
import { resetDb } from '../../helpers/resetDb';
import { testPool } from '../../helpers/testPool';

let app: any;

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;
  const indexModule = await import('../../../src/index');
  app = indexModule.app;
});

const registerUser = async (email: string): Promise<{ token: string; userId: string }> => {
  const res = await request(app).post('/api/v1/auth/register').send({
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
    const res = await request(app).get('/api/v1/admin/health');
    expect(res.status).toBe(401);
  });

  it('rejects an authenticated non-admin with 403', async () => {
    const { token } = await registerUser('plain@example.com');

    const res = await request(app)
      .get('/api/v1/admin/health')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
  });

  it('allows a user whose row has is_admin = true', async () => {
    const { token, userId } = await registerUser('admin@example.com');
    await promote(userId);

    const res = await request(app)
      .get('/api/v1/admin/health')
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
      .get('/api/v1/admin/health')
      .set('Authorization', `Bearer ${token}`);
    expect(allowed.status).toBe(200);

    await testPool`UPDATE users SET is_admin = false WHERE user_id = ${userId}`;

    const denied = await request(app)
      .get('/api/v1/admin/health')
      .set('Authorization', `Bearer ${token}`);
    expect(denied.status).toBe(403);
  });

  it('does not let a soft-deleted admin through', async () => {
    const { token, userId } = await registerUser('deleted@example.com');
    await promote(userId);
    await testPool`UPDATE users SET deleted_at = NOW() WHERE user_id = ${userId}`;

    const res = await request(app)
      .get('/api/v1/admin/health')
      .set('Authorization', `Bearer ${token}`);

    // authMiddleware rejects the deleted account first; the admin gate is a
    // second, independent soft-delete filter behind it.
    expect(res.status).toBe(401);
  });
});
