import { describe, it, expect, beforeAll, beforeEach } from 'bun:test';
import { request } from '../../helpers/http';
import { resetDb } from '../../helpers/resetDb';

let app: any;

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;
  const indexModule = await import('../../../src/index');
  app = indexModule.honoApp;
});

describe('User E2E', () => {
  let token: string;
  let userId: string;

  beforeEach(async () => {
    await resetDb();
    const res = await request(app).post('/api/v1/auth/register').send({
      name: 'User',
      email: 'user@example.com',
      password: 'Password123!',
    });
    token = res.body.token;
    userId = res.body.user.userId;
  });

  it('should get current user profile', async () => {
    const res = await request(app)
      .get('/api/v1/users/me')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.userId).toBe(userId);
    expect(res.body.name).toBe('User');
  });

  it('should fail without token', async () => {
    const res = await request(app).get('/api/v1/users/me');
    expect(res.status).toBe(401);
  });

  it('should fail with invalid token', async () => {
    const res = await request(app)
      .get('/api/v1/users/me')
      .set('Authorization', `Bearer invalid_token`);
    expect(res.status).toBe(401);
  });
});
