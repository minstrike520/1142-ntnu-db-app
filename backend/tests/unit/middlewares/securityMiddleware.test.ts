import { describe, it, test, beforeAll, beforeEach, afterAll, afterEach } from 'bun:test';

// Bun-compatibility helper for Vitest/Jest APIs
import { mock, spyOn, afterAll, expect as originalExpect, jest } from 'bun:test';
let mockedModules: any[] = [];
afterAll(() => {
  for (const m of mockedModules) {
    if (m && m.path) {
      mock.module(m.path, () => m.original);
    }
  }
  mockedModules = [];
});
function createVitestMockProxy(f: any) {
  const extensions = {
    mockResolvedValue(val: any) {
      f.mockImplementation(() => Promise.resolve(val));
      return proxy;
    },
    mockRejectedValue(val: any) {
      f.mockImplementation(() => Promise.reject(val));
      return proxy;
    },
    mockResolvedValueOnce(val: any) {
      if (typeof f.mockImplementationOnce === "function") {
        f.mockImplementationOnce(() => Promise.resolve(val));
      } else {
        f.mockImplementation(() => Promise.resolve(val));
      }
      return proxy;
    },
    mockRejectedValueOnce(val: any) {
      if (typeof f.mockImplementationOnce === "function") {
        f.mockImplementationOnce(() => Promise.reject(val));
      } else {
        f.mockImplementation(() => Promise.reject(val));
      }
      return proxy;
    },
    mockReset() {
      f.mockClear();
      f.mockImplementation(() => {});
      return proxy;
    }
  };
  const proxy = new Proxy(f, {
    get(target, prop, receiver) {
      if (prop === "__is_vitest_mock_proxy__") return true;
      if (prop === "__original_target__") return target;
      if (prop in extensions) return (extensions as any)[prop];
      const val = Reflect.get(target, prop);
      if (typeof val === "function") return val.bind(target);
      return val;
    },
    set(target, prop, value, receiver) {
      return Reflect.set(target, prop, value);
    }
  });
  return proxy;
}
const vi = {
  fn: (impl?: any) => createVitestMockProxy(mock(impl)),
  spyOn: (obj: any, method: string) => createVitestMockProxy(spyOn(obj, method as any)),
  mock: (path: string, factory?: any) => {
    let original: any = null;
    try {
      original = require(path);
    } catch (e) {}
    mockedModules.push({ path, original });
    return mock.module(path, factory || (() => ({})));
  },
  mocked: <T>(obj: T) => obj as any,
  restoreAllMocks: () => {
    jest.restoreAllMocks();
    for (const m of mockedModules) {
      if (m && m.path) {
        mock.module(m.path, () => m.original);
      }
    }
    mockedModules = [];
  },
  resetAllMocks: () => {
    jest.resetAllMocks();
  },
  clearAllMocks: () => {
    jest.clearAllMocks();
  },
  stubEnv: (name: string, value: string) => {
    if (!globalThis.__envStubs) globalThis.__envStubs = {};
    if (!(name in globalThis.__envStubs)) globalThis.__envStubs[name] = process.env[name];
    process.env[name] = value;
  },
  unstubAllEnvs: () => {
    if (globalThis.__envStubs) {
      for (const name in globalThis.__envStubs) {
        const val = globalThis.__envStubs[name];
        if (val === undefined) delete process.env[name];
        else process.env[name] = val;
      }
      globalThis.__envStubs = null;
    }
  },
  useFakeTimers: () => {
    globalThis.__activeIntervals = [];
    globalThis.__originalSetInterval = globalThis.setInterval;
    globalThis.__originalClearInterval = globalThis.clearInterval;
    globalThis.setInterval = (callback: any, delay?: number, ...args: any[]) => {
      const id = Math.random();
      globalThis.__activeIntervals.push({ callback: () => callback(...args), delay: delay || 0, id });
      return id as any;
    };
    globalThis.clearInterval = (id: any) => {
      globalThis.__activeIntervals = globalThis.__activeIntervals.filter((item: any) => item.id !== id);
    };
  },
  useRealTimers: () => {
    if (globalThis.__originalSetInterval) {
      globalThis.setInterval = globalThis.__originalSetInterval;
      globalThis.clearInterval = globalThis.__originalClearInterval;
    }
    globalThis.__activeIntervals = [];
  },
  advanceTimersByTime: (ms: number) => {
    if (globalThis.__activeIntervals) {
      for (const item of globalThis.__activeIntervals) {
        item.callback();
      }
    }
  },
  advanceTimersByTimeAsync: async (ms: number) => {
    if (globalThis.__activeIntervals) {
      const promises = globalThis.__activeIntervals.map((item: any) => item.callback());
      await Promise.all(promises);
    }
  },
  waitFor: async (callback: () => any, options?: { timeout?: number; interval?: number }) => {
    const timeout = options?.timeout || 5000;
    const interval = options?.interval || 50;
    const startTime = Date.now();
    while (true) {
      try {
        await callback();
        return;
      } catch (err) {
        if (Date.now() - startTime > timeout) {
          throw err;
        }
        await new Promise(resolve => setTimeout(resolve, interval));
      }
    }
  }
};
const expect = (actual: any) => {
  if (actual && typeof actual === 'function' && actual.__is_vitest_mock_proxy__) {
    actual = actual.__original_target__;
  }
  return originalExpect(actual);
};
Object.setPrototypeOf(expect, originalExpect);
Object.defineProperties(expect, Object.getOwnPropertyDescriptors(originalExpect));

import express from 'express';
import request from 'supertest';

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
