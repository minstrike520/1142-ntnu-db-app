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


import type { Response } from 'express';
import {
  REFRESH_COOKIE_NAME,
  setRefreshCookie,
  clearRefreshCookie,
  readCookie,
} from '../../../src/auth/cookies';

const makeRes = () =>
  ({ cookie: vi.fn(), clearCookie: vi.fn() }) as unknown as Response;

describe('cookies', () => {
  describe('setRefreshCookie', () => {
    it('sets the refresh cookie with httpOnly and strict sameSite', () => {
      const res = makeRes();
      setRefreshCookie(res, 'token-123');
      expect(res.cookie).toHaveBeenCalledWith(
        REFRESH_COOKIE_NAME,
        'token-123',
        expect.objectContaining({
          httpOnly: true,
          sameSite: 'strict',
          path: '/',
          maxAge: expect.any(Number),
        })
      );
    });

    it('defaults the cookie maxAge to the refresh token TTL', () => {
      const originalMaxAge = process.env.REFRESH_COOKIE_MAX_AGE_MS;
      const originalDays = process.env.JWT_REFRESH_EXPIRES_IN_DAYS;
      delete process.env.REFRESH_COOKIE_MAX_AGE_MS;
      process.env.JWT_REFRESH_EXPIRES_IN_DAYS = '14';
      try {
        const res = makeRes();
        setRefreshCookie(res, 'token-123');
        const options = (res.cookie as ReturnType<typeof vi.fn>).mock.calls[0][2];
        expect(options.maxAge).toBe(14 * 24 * 60 * 60 * 1000);
      } finally {
        if (originalMaxAge !== undefined) process.env.REFRESH_COOKIE_MAX_AGE_MS = originalMaxAge;
        if (originalDays !== undefined) {
          process.env.JWT_REFRESH_EXPIRES_IN_DAYS = originalDays;
        } else {
          delete process.env.JWT_REFRESH_EXPIRES_IN_DAYS;
        }
      }
    });
  });

  describe('clearRefreshCookie', () => {
    it('clears the refresh cookie with matching options', () => {
      const res = makeRes();
      clearRefreshCookie(res);
      expect(res.clearCookie).toHaveBeenCalledWith(
        REFRESH_COOKIE_NAME,
        expect.objectContaining({ httpOnly: true, sameSite: 'strict', path: '/' })
      );
    });
  });

  describe('readCookie', () => {
    it('returns undefined when the header is missing', () => {
      expect(readCookie(undefined, 'auth_token')).toBeUndefined();
    });

    it('reads a cookie value from the header', () => {
      expect(readCookie('auth_token=abc; other=1', 'auth_token')).toBe('abc');
    });

    it('preserves "=" characters inside the value', () => {
      expect(readCookie('auth_token=a=b=c', 'auth_token')).toBe('a=b=c');
    });

    it('decodes URI-encoded values', () => {
      expect(readCookie('auth_token=a%20b', 'auth_token')).toBe('a b');
    });

    it('returns undefined when the cookie is not present', () => {
      expect(readCookie('other=1; another=2', 'auth_token')).toBeUndefined();
    });

    it('returns undefined for a cookie with no value', () => {
      expect(readCookie('auth_token', 'auth_token')).toBeUndefined();
    });
  });
});
