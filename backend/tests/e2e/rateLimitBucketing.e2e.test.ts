import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { makeGlobalRateLimiter } from '../../src/middlewares/securityMiddleware';
import { errorHandler } from '../../src/middlewares/errorHandler';

/**
 * Rate-limit bucketing over a real socket.
 *
 * The unit tests drive `getClientIp` with synthetic contexts, which cannot show
 * whether the peer address is actually recoverable at runtime — and that address
 * is the whole fallback when no proxy is trusted. Here the requests genuinely
 * travel over TCP through Bun.serve, the same adapter production uses,
 * so the header path and the socket path are exercised as they really compose.
 *
 * Covers the guarantees issue #413 asks for: one caller cannot exhaust another's
 * budget, and no caller can pick its own bucket by sending `X-Forwarded-For`.
 */

const originalNodeEnv = process.env.NODE_ENV;
const originalRateLimitDisabled = process.env.RATE_LIMIT_DISABLED;
const originalTrustProxy = process.env.TRUST_PROXY;
const originalTrustProxyHops = process.env.TRUST_PROXY_HOPS;

let server: Bun.Server<unknown>;
let baseUrl: string;

// One limiter instance holds one in-memory store, so each test takes a fresh one
// to start from an empty count. Within a test it must stay the same instance or
// nothing ever accumulates. `keyGenerator` and `skip` read the environment per
// request, so swapping the instance is enough to re-read the trust settings too.
let limiter: MiddlewareHandler;
const resetLimiter = () => {
  limiter = makeGlobalRateLimiter({ windowMs: 60_000, limit: 2 });
};

const app = new Hono();
app.onError(errorHandler);
app.use('/api/ping', (c, next) => limiter(c, next));
app.get('/api/ping', (c) => c.json({ ok: true }));

const ping = async (headers: Record<string, string> = {}): Promise<number> => {
  const res = await fetch(`${baseUrl}/api/ping`, { headers });
  await res.arrayBuffer();
  return res.status;
};

const restore = (name: string, value: string | undefined) => {
  if (value !== undefined) {
    process.env[name] = value;
  } else {
    delete process.env[name];
  }
};

beforeAll(async () => {
  server = Bun.serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
  baseUrl = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server?.stop(true);
});

afterEach(() => {
  restore('NODE_ENV', originalNodeEnv);
  restore('RATE_LIMIT_DISABLED', originalRateLimitDisabled);
  restore('TRUST_PROXY', originalTrustProxy);
  restore('TRUST_PROXY_HOPS', originalTrustProxyHops);
});

const enableLimiter = () => {
  process.env.NODE_ENV = 'production';
  delete process.env.RATE_LIMIT_DISABLED;
  resetLimiter();
};

describe('rate limit bucketing over a real connection', () => {
  it('falls back to the peer address when no proxy is trusted', async () => {
    enableLimiter();
    delete process.env.TRUST_PROXY;
    delete process.env.TRUST_PROXY_HOPS;

    // Every request here shares one peer address (127.0.0.1), so the budget is
    // spent in order — proving the socket address was resolved rather than
    // silently coming back undefined and handing each request its own key.
    expect(await ping()).toBe(200);
    expect(await ping()).toBe(200);
    expect(await ping()).toBe(429);
  });

  it('ignores X-Forwarded-For when no proxy is trusted', async () => {
    enableLimiter();
    delete process.env.TRUST_PROXY;
    delete process.env.TRUST_PROXY_HOPS;

    // A caller cannot mint fresh buckets for itself by varying the header.
    expect(await ping({ 'x-forwarded-for': '203.0.113.1' })).toBe(200);
    expect(await ping({ 'x-forwarded-for': '203.0.113.2' })).toBe(200);
    expect(await ping({ 'x-forwarded-for': '203.0.113.3' })).toBe(429);
  });

  it('separates callers by the hop the trusted proxy appended', async () => {
    enableLimiter();
    process.env.TRUST_PROXY_HOPS = '1';

    // Two distinct clients arriving through the same proxy: one exhausting its
    // budget must not spend the other's, which is the tunnel failure mode.
    expect(await ping({ 'x-forwarded-for': '198.51.100.1' })).toBe(200);
    expect(await ping({ 'x-forwarded-for': '198.51.100.1' })).toBe(200);
    expect(await ping({ 'x-forwarded-for': '198.51.100.1' })).toBe(429);

    expect(await ping({ 'x-forwarded-for': '198.51.100.2' })).toBe(200);
  });

  it('does not let a caller escape its bucket by prepending to the chain', async () => {
    enableLimiter();
    process.env.TRUST_PROXY_HOPS = '1';

    expect(await ping({ 'x-forwarded-for': '198.51.100.9' })).toBe(200);
    expect(await ping({ 'x-forwarded-for': '198.51.100.9' })).toBe(200);
    // Same caller as far as our proxy is concerned; the padding is untrusted.
    expect(await ping({ 'x-forwarded-for': '203.0.113.7, 198.51.100.9' })).toBe(429);
    expect(await ping({ 'x-forwarded-for': '10.0.0.1, 10.0.0.2, 198.51.100.9' })).toBe(429);
  });

  it('falls back to the peer address for a request that skipped the proxy', async () => {
    enableLimiter();
    process.env.TRUST_PROXY_HOPS = '2';

    // Only one entry, but two hops are expected, so this did not come through the
    // documented path. It must be attributed to the peer rather than to the
    // caller-supplied entry — otherwise a direct connection picks its own bucket.
    expect(await ping({ 'x-forwarded-for': '203.0.113.5' })).toBe(200);
    expect(await ping({ 'x-forwarded-for': '203.0.113.6' })).toBe(200);
    expect(await ping({ 'x-forwarded-for': '203.0.113.7' })).toBe(429);
  });
});
