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


import { Request, Response, NextFunction } from 'express';
import { authMiddleware } from '../../../src/middlewares/authMiddleware';
import * as jwtHelper from '../../../src/auth/jwt';
import { AppError } from '../../../src/errors/AppError';
import pool from '../../../src/db';

vi.mock('../../../src/db', () => ({
  default: { query: vi.fn() },
}));

describe('authMiddleware', () => {
  let mockRequest: Partial<Request>;
  let mockResponse: Partial<Response>;
  let nextFunction: NextFunction;

  beforeEach(() => {
    mockRequest = {
      headers: {},
    };
    mockResponse = {};
    nextFunction = vi.fn();
    // vi.restoreAllMocks() resets vi.fn() implementations, so re-apply after each test
    vi.mocked(pool.query).mockResolvedValue({ rows: [{}] } as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls next with 401 when auth token is missing', async () => {
    await authMiddleware(mockRequest as Request, mockResponse as Response, nextFunction);
    expect(nextFunction).toHaveBeenCalledOnce();
    const arg = vi.mocked(nextFunction).mock.calls[0][0] as AppError;
    expect(arg).toBeInstanceOf(AppError);
    expect(arg.statusCode).toBe(401);
    expect(arg.message).toMatch(/Missing authentication token/);
  });

  it('calls next with 401 when Authorization header is malformed and no cookie exists', async () => {
    mockRequest.headers = { authorization: 'Basic sometoken' };
    await authMiddleware(mockRequest as Request, mockResponse as Response, nextFunction);
    expect(nextFunction).toHaveBeenCalledOnce();
    const arg = vi.mocked(nextFunction).mock.calls[0][0] as AppError;
    expect(arg).toBeInstanceOf(AppError);
    expect(arg.statusCode).toBe(401);
    expect(arg.message).toMatch(/Missing authentication token/);
  });

  it('calls next with 401 when token is invalid', async () => {
    mockRequest.headers = { authorization: 'Bearer invalid-token' };
    vi.spyOn(jwtHelper, 'verifyToken').mockImplementation(() => {
      throw new Error('Invalid token');
    });

    await authMiddleware(mockRequest as Request, mockResponse as Response, nextFunction);
    expect(nextFunction).toHaveBeenCalledOnce();
    const arg = vi.mocked(nextFunction).mock.calls[0][0] as AppError;
    expect(arg).toBeInstanceOf(AppError);
    expect(arg.statusCode).toBe(401);
    expect(arg.message).toMatch(/Invalid token/);
  });

  it('calls next() and populates req.user when token is valid and user is active', async () => {
    mockRequest.headers = { authorization: 'Bearer valid-token' };
    const mockPayload = { userId: '1', name: 'Test User' };
    
    vi.spyOn(jwtHelper, 'verifyToken').mockReturnValue(mockPayload);

    await authMiddleware(mockRequest as Request, mockResponse as Response, nextFunction);

    expect(mockRequest.user).toEqual(mockPayload);
    expect(nextFunction).toHaveBeenCalledOnce();
    expect(nextFunction).toHaveBeenCalledWith(); // called with no args
  });

  it('prefers the HttpOnly auth cookie token when present', async () => {
    mockRequest.headers = {
      authorization: 'Bearer header-token',
      cookie: 'theme=dark; auth_token=cookie-token',
    };
    const mockPayload = { userId: '1', name: 'Test User' };

    vi.spyOn(jwtHelper, 'verifyToken').mockReturnValue(mockPayload);

    await authMiddleware(mockRequest as Request, mockResponse as Response, nextFunction);

    expect(jwtHelper.verifyToken).toHaveBeenCalledWith('cookie-token');
    expect(mockRequest.user).toEqual(mockPayload);
    expect(nextFunction).toHaveBeenCalledOnce();
    expect(nextFunction).toHaveBeenCalledWith();
  });

  it('calls next with 401 when user is not found in the database', async () => {
    mockRequest.headers = { authorization: 'Bearer valid-token' };
    vi.spyOn(jwtHelper, 'verifyToken').mockReturnValue({ userId: '1', name: 'Test User' });
    vi.mocked(pool.query).mockResolvedValueOnce({ rows: [] } as any);
    await authMiddleware(mockRequest as Request, mockResponse as Response, nextFunction);
    const arg = vi.mocked(nextFunction).mock.calls[0][0] as AppError;
    expect(arg).toBeInstanceOf(AppError);
    expect(arg.statusCode).toBe(401);
    expect(arg.message).toMatch(/not found or deleted/);
  });

  it('calls next with the original AppError when verifyToken throws an AppError', async () => {
    mockRequest.headers = { authorization: 'Bearer valid-token' };
    const customErr = new AppError(403, 'Custom forbidden');
    vi.spyOn(jwtHelper, 'verifyToken').mockImplementation(() => { throw customErr; });
    await authMiddleware(mockRequest as Request, mockResponse as Response, nextFunction);
    expect(nextFunction).toHaveBeenCalledWith(customErr);
  });
});
