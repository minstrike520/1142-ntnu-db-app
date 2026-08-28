import { describe, it, expect, beforeAll, beforeEach } from 'bun:test';
import type { Hono } from 'hono';
import { request } from '../../helpers/http';
import { resetDb } from '../../helpers/resetDb';
import type { AuthResponse, UserProfileResponse } from '../../helpers/responseTypes';

let app: Hono;

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;
  const indexModule = await import('../../../src/index');
  app = indexModule.honoApp;
});

describe('Auth E2E', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('should register a new user successfully', async () => {
    const res = await request(app).post<AuthResponse>('/api/v1/auth/register').send({
      name: 'Test User',
      email: 'test@example.com',
      password: 'Password123!',
    });
    if (res.status !== 201) throw new Error("RES: " + JSON.stringify(res.body));
    expect(res.body.token).toBeDefined();
    expect((res.headers['set-cookie'] as string[] | undefined)?.join(';')).toContain('refresh_token=');
    expect((res.headers['set-cookie'] as string[] | undefined)?.join(';')).toContain('HttpOnly');
    expect((res.headers['set-cookie'] as string[] | undefined)?.join(';')).toContain('SameSite=Strict');
    expect(res.body.user).toBeDefined();
    expect(res.body.user.name).toBe('Test User');
  });

  it('should fail registration if email is duplicate', async () => {
    await request(app).post<AuthResponse>('/api/v1/auth/register').send({
      name: 'Test User',
      email: 'test@example.com',
      password: 'Password123!',
    });

    const res = await request(app).post<{ message: string }>('/api/v1/auth/register').send({
      name: 'Another User',
      email: 'test@example.com',
      password: 'Password123!',
    });
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/duplicate|already exists|already in use/i);
  });

  it('should login an existing user', async () => {
    await request(app).post<AuthResponse>('/api/v1/auth/register').send({
      name: 'Test User',
      email: 'test@example.com',
      password: 'Password123!',
    });

    const res = await request(app).post<AuthResponse>('/api/v1/auth/login').send({
      email: 'test@example.com',
      password: 'Password123!',
    });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();
    expect((res.headers['set-cookie'] as string[] | undefined)?.join(';')).toContain('refresh_token=');
  });

  it('should authenticate protected routes with the auth header', async () => {
    const register = await request(app).post<AuthResponse>('/api/v1/auth/register').send({
      name: 'Cookie User',
      email: 'cookie@example.com',
      password: 'Password123!',
    });
    const token = register.body.token;
    const cookie = register.headers['set-cookie'];

    const me = await request(app).get<UserProfileResponse>('/api/v1/users/me').set('Authorization', `Bearer ${token}`);
    expect(me.status).toBe(200);
    expect(me.body.name).toBe('Cookie User');

    const logout = await request(app).post('/api/v1/auth/logout').set('Cookie', cookie).set('Authorization', `Bearer ${token}`);
    expect(logout.status).toBe(204);
    expect((logout.headers['set-cookie'] as string[] | undefined)?.join(';')).toContain('refresh_token=');
  });

  it('should refresh access token using refresh token cookie', async () => {
    const register = await request(app).post<AuthResponse>('/api/v1/auth/register').send({
      name: 'Refresh User',
      email: 'refresh@example.com',
      password: 'Password123!',
    });
    const cookie = register.headers['set-cookie'];

    const res = await request(app).post<AuthResponse>('/api/v1/auth/refresh').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();
    expect((res.headers['set-cookie'] as string[] | undefined)?.join(';')).toContain('refresh_token=');
  });

  it('should fail login with incorrect password', async () => {
    await request(app).post<AuthResponse>('/api/v1/auth/register').send({
      name: 'Test User',
      email: 'test@example.com',
      password: 'Password123!',
    });

    const res = await request(app).post<{ message: string }>('/api/v1/auth/login').send({
      email: 'test@example.com',
      password: 'WrongPassword!',
    });
    expect(res.status).toBe(400);
  });
});
