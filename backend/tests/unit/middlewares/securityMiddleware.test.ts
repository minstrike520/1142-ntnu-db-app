import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'bun:test';
import {
  makeAuthRateLimiter,
  makeGlobalRateLimiter,
  securityHeaders,
} from '../../../src/middlewares/securityMiddleware';

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

  it('adds standard Helmet security headers', async () => {
    const app = express();
    app.use(securityHeaders);
    app.get('/ok', (_req, res) => res.json({ ok: true }));

    const res = await request(app).get('/ok').expect(200);

    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
  });

  it('limits baseline API request volume when enabled', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.RATE_LIMIT_DISABLED;
    const app = express();
    app.use(makeGlobalRateLimiter({ windowMs: 60_000, limit: 2 }));
    app.get('/api/ping', (_req, res) => res.json({ ok: true }));

    await request(app).get('/api/ping').expect(200);
    await request(app).get('/api/ping').expect(200);
    const limited = await request(app).get('/api/ping').expect(429);

    expect(limited.body.message).toBe('Too many requests, please try again later');
  });

  it('uses cross-origin headers for /uploads/avatars exact path', async () => {
    const app = express();
    app.use(securityHeaders);
    app.get('/uploads/avatars', (_req, res) => res.json({ ok: true }));

    const res = await request(app).get('/uploads/avatars').expect(200);

    expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin');
  });

  it('uses cross-origin headers for /uploads/avatars/* subpaths', async () => {
    const app = express();
    app.use(securityHeaders);
    app.get('/uploads/avatars/img.png', (_req, res) => res.json({ ok: true }));

    const res = await request(app).get('/uploads/avatars/img.png').expect(200);

    expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin');
  });

  it('skips rate limiting when RATE_LIMIT_DISABLED=true regardless of NODE_ENV', async () => {
    process.env.NODE_ENV = 'production';
    process.env.RATE_LIMIT_DISABLED = 'true';
    const app = express();
    app.use(makeGlobalRateLimiter({ windowMs: 60_000, limit: 1 }));
    app.get('/api/ping', (_req, res) => res.json({ ok: true }));

    await request(app).get('/api/ping').expect(200);
    await request(app).get('/api/ping').expect(200);
  });

  it('uses a stricter auth limiter message when enabled', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.RATE_LIMIT_DISABLED;
    const app = express();
    app.use(makeAuthRateLimiter({ windowMs: 60_000, limit: 1, skipSuccessfulRequests: false }));
    app.post('/api/v1/auth/login', (_req, res) => res.status(401).json({ message: 'Invalid' }));

    await request(app).post('/api/v1/auth/login').expect(401);
    const limited = await request(app).post('/api/v1/auth/login').expect(429);

    expect(limited.body.message).toBe('Too many authentication attempts, please try again later');
  });
});
