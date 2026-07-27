import { describe, it, expect, afterEach, spyOn } from 'bun:test';
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
  const originalTrustProxy = process.env.TRUST_PROXY;
  const originalTrustedProxyIps = process.env.TRUSTED_PROXY_IPS;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    if (originalRateLimitDisabled !== undefined) {
      process.env.RATE_LIMIT_DISABLED = originalRateLimitDisabled;
    } else {
      delete process.env.RATE_LIMIT_DISABLED;
    }
    if (originalTrustProxy !== undefined) {
      process.env.TRUST_PROXY = originalTrustProxy;
    } else {
      delete process.env.TRUST_PROXY;
    }
    if (originalTrustedProxyIps !== undefined) {
      process.env.TRUSTED_PROXY_IPS = originalTrustedProxyIps;
    } else {
      delete process.env.TRUSTED_PROXY_IPS;
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
    process.env.TRUST_PROXY = 'true';
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
    process.env.TRUST_PROXY = 'true';
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

  describe('rate limit bucketing', () => {
    const makeApp = () => {
      const app = new Hono();
      app.onError(errorHandler);
      app.use('/api/ping', makeGlobalRateLimiter({ windowMs: 60_000, limit: 1 }));
      app.get('/api/ping', (c) => c.json({ ok: true }));
      return app;
    };

    it('separates buckets per forwarded IP when the proxy is trusted', async () => {
      process.env.NODE_ENV = 'production';
      process.env.TRUST_PROXY = 'true';
      delete process.env.RATE_LIMIT_DISABLED;
      const app = makeApp();

      expect((await app.request('/api/ping', { headers: { 'x-forwarded-for': '10.0.0.1' } })).status).toBe(200);
      // A different client must not inherit the first client's exhausted budget.
      expect((await app.request('/api/ping', { headers: { 'x-forwarded-for': '10.0.0.2' } })).status).toBe(200);
      // ...while the first one stays limited.
      expect((await app.request('/api/ping', { headers: { 'x-forwarded-for': '10.0.0.1' } })).status).toBe(429);
    });

    it('uses the last hop of a forwarded chain, not the caller-supplied prefix', async () => {
      process.env.NODE_ENV = 'production';
      process.env.TRUST_PROXY = 'true';
      delete process.env.RATE_LIMIT_DISABLED;
      const app = makeApp();

      // A proxy appends the address it actually received the connection from,
      // so only the rightmost hop is outside the caller's control. Prefixing
      // the header must not let a caller move itself to a fresh bucket.
      const headers = { 'x-forwarded-for': '10.0.0.9, 172.16.0.1, 192.168.0.1' };
      expect((await app.request('/api/ping', { headers })).status).toBe(200);
      expect((await app.request('/api/ping', { headers: { 'x-forwarded-for': '192.168.0.1' } })).status).toBe(429);
      // The spoofable prefix is not a bucket of its own.
      expect((await app.request('/api/ping', { headers: { 'x-forwarded-for': 'evil, 192.168.0.1' } })).status).toBe(429);
    });

    it('separates buckets per visitor behind a listed trusted proxy', async () => {
      process.env.NODE_ENV = 'production';
      delete process.env.TRUST_PROXY;
      process.env.TRUSTED_PROXY_IPS = '10.83.71.250';
      delete process.env.RATE_LIMIT_DISABLED;
      const app = makeApp();

      const viaTunnel = (visitorIp: string) =>
        app.request(
          '/api/ping',
          { headers: { 'cf-connecting-ip': visitorIp } },
          { incoming: { socket: { remoteAddress: '10.83.71.250' } } },
        );

      expect((await viaTunnel('203.0.113.7')).status).toBe(200);
      // One visitor exhausting their budget must not lock anyone else out.
      expect((await viaTunnel('203.0.113.8')).status).toBe(200);
      expect((await viaTunnel('203.0.113.7')).status).toBe(429);
    });

    it('ignores forwarded headers from a peer that is not the listed proxy', async () => {
      process.env.NODE_ENV = 'production';
      delete process.env.TRUST_PROXY;
      process.env.TRUSTED_PROXY_IPS = '10.83.71.250';
      delete process.env.RATE_LIMIT_DISABLED;
      const app = makeApp();

      // Anything reaching the published port has a different peer address, so
      // it stays pinned to that address' bucket however it labels itself.
      const direct = (visitorIp: string) =>
        app.request(
          '/api/ping',
          { headers: { 'cf-connecting-ip': visitorIp, 'x-forwarded-for': visitorIp } },
          { incoming: { socket: { remoteAddress: '10.83.71.1' } } },
        );

      // Silences the (expected) diagnostic this path emits outside NODE_ENV=test.
      const warn = spyOn(console, 'warn').mockImplementation(() => {});
      try {
        expect((await direct('203.0.113.7')).status).toBe(200);
        expect((await direct('203.0.113.8')).status).toBe(429);
      } finally {
        warn.mockRestore();
      }
    });

    it('ignores X-Forwarded-For when the proxy is not trusted', async () => {
      process.env.NODE_ENV = 'production';
      delete process.env.TRUST_PROXY;
      delete process.env.RATE_LIMIT_DISABLED;
      const app = makeApp();

      // A spoofed header must not be able to pick its own bucket.
      expect((await app.request('/api/ping', { headers: { 'x-forwarded-for': '10.0.0.1' } })).status).toBe(200);
      expect((await app.request('/api/ping', { headers: { 'x-forwarded-for': '10.0.0.2' } })).status).toBe(200);
    });

    it('does not funnel header-less callers into one shared bucket', async () => {
      process.env.NODE_ENV = 'production';
      delete process.env.TRUST_PROXY;
      delete process.env.RATE_LIMIT_DISABLED;
      const app = makeApp();

      // These requests carry neither a trusted header nor socket info. Under the
      // old fixed 'unknown-ip' key the second one would already be a 429, which
      // is exactly how one caller could lock out the whole service.
      expect((await app.request('/api/ping')).status).toBe(200);
      expect((await app.request('/api/ping')).status).toBe(200);
      expect((await app.request('/api/ping')).status).toBe(200);
    });
  });
});
