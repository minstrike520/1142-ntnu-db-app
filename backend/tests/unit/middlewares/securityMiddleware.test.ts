import { describe, it, expect, afterEach } from 'bun:test';
import { Hono } from 'hono';
import {
  makeAuthRateLimiter,
  makeGlobalRateLimiter,
  securityHeaders,
} from '../../../src/middlewares/securityMiddleware';
import { errorHandler } from '../../../src/middlewares/errorHandler';

describe('security middleware', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalRateLimitDisabled = process.env.RATE_LIMIT_DISABLED;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    if (originalRateLimitDisabled !== undefined) {
      process.env.RATE_LIMIT_DISABLED = originalRateLimitDisabled;
    } else {
      delete process.env.RATE_LIMIT_DISABLED;
    }
  });

  it('adds standard Hono security headers', async () => {
    const app = new Hono();
    app.onError(errorHandler);
    app.use('*', securityHeaders);
    app.get('/ok', (c) => c.json({ ok: true }));

    const res = await app.request('/ok');
    expect(res.status).toBe(200);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('SAMEORIGIN');
  });

  it('limits baseline API request volume when enabled', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.RATE_LIMIT_DISABLED;
    const app = new Hono();
    app.onError(errorHandler);
    app.use('/api/ping', makeGlobalRateLimiter({ windowMs: 60_000, limit: 2 }));
    app.get('/api/ping', (c) => c.json({ ok: true }));

    const headers = { 'x-forwarded-for': '127.0.0.1' };
    const res1 = await app.request('/api/ping', { headers });
    expect(res1.status).toBe(200);
    const res2 = await app.request('/api/ping', { headers });
    expect(res2.status).toBe(200);
    const res3 = await app.request('/api/ping', { headers });
    expect(res3.status).toBe(429);

    const body = await res3.json();
    expect(body.message).toBe('Too many requests, please try again later');
  });

  it('uses cross-origin headers for /uploads/avatars exact path', async () => {
    const app = new Hono();
    app.onError(errorHandler);
    app.use('*', securityHeaders);
    app.get('/uploads/avatars', (c) => c.json({ ok: true }));

    const res = await app.request('/uploads/avatars');
    expect(res.status).toBe(200);
    expect(res.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
  });

  it('uses cross-origin headers for /uploads/avatars/* subpaths', async () => {
    const app = new Hono();
    app.onError(errorHandler);
    app.use('*', securityHeaders);
    app.get('/uploads/avatars/img.png', (c) => c.json({ ok: true }));

    const res = await app.request('/uploads/avatars/img.png');
    expect(res.status).toBe(200);
    expect(res.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
  });

  it('skips rate limiting when RATE_LIMIT_DISABLED=true regardless of NODE_ENV', async () => {
    process.env.NODE_ENV = 'production';
    process.env.RATE_LIMIT_DISABLED = 'true';
    const app = new Hono();
    app.onError(errorHandler);
    app.use('/api/ping', makeGlobalRateLimiter({ windowMs: 60_000, limit: 1 }));
    app.get('/api/ping', (c) => c.json({ ok: true }));

    const headers = { 'x-forwarded-for': '127.0.0.1' };
    const res1 = await app.request('/api/ping', { headers });
    expect(res1.status).toBe(200);
    const res2 = await app.request('/api/ping', { headers });
    expect(res2.status).toBe(200);
  });

  it('uses a stricter auth limiter message when enabled', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.RATE_LIMIT_DISABLED;
    const app = new Hono();
    app.onError(errorHandler);
    app.use('/api/v1/auth/login', makeAuthRateLimiter({ windowMs: 60_000, limit: 1 }));
    app.post('/api/v1/auth/login', (c) => c.json({ message: 'Invalid' }, 401));

    const headers = { 'x-forwarded-for': '127.0.0.1' };
    const res1 = await app.request('/api/v1/auth/login', { method: 'POST', headers });
    expect(res1.status).toBe(401);
    const res2 = await app.request('/api/v1/auth/login', { method: 'POST', headers });
    expect(res2.status).toBe(429);

    const body = await res2.json();
    expect(body.message).toBe('Too many authentication attempts, please try again later');
  });
});
