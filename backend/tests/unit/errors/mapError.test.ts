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


import multer from 'multer';
import { mapErrorToApiShape } from '../../../src/errors/mapError';
import { AppError, ValidationError, ForbiddenError, NotFoundError, ConflictError } from '../../../src/errors/AppError';

describe('mapErrorToApiShape', () => {
  it('maps ValidationError (400)', () => {
    const err = new ValidationError('bad request');
    expect(mapErrorToApiShape(err)).toEqual({
      statusCode: 400,
      message: 'bad request',
      code: 'VALIDATION_ERROR',
    });
  });

  it('maps AppError directly (e.g. 401)', () => {
    const err = new AppError(401, 'unauth', 'UNAUTHORIZED');
    expect(mapErrorToApiShape(err)).toEqual({
      statusCode: 401,
      message: 'unauth',
      code: 'UNAUTHORIZED',
    });
  });

  it('maps ForbiddenError (403)', () => {
    const err = new ForbiddenError('forbidden');
    expect(mapErrorToApiShape(err)).toEqual({
      statusCode: 403,
      message: 'forbidden',
      code: 'FORBIDDEN',
    });
  });

  it('maps NotFoundError (404)', () => {
    const err = new NotFoundError('User', '123');
    expect(mapErrorToApiShape(err)).toEqual({
      statusCode: 404,
      message: 'User with id 123 not found',
      code: 'NOT_FOUND',
    });
  });

  it('maps ConflictError (409)', () => {
    const err = new ConflictError('conflict');
    expect(mapErrorToApiShape(err)).toEqual({
      statusCode: 409,
      message: 'conflict',
      code: 'CONFLICT',
    });
  });

  it('maps unknown errors to 500', () => {
    const err = new Error('database connection failed');
    expect(mapErrorToApiShape(err)).toEqual({
      statusCode: 500,
      message: 'Internal Server Error',
      code: 'INTERNAL_ERROR',
    });
  });

  it('logs unknown errors outside the test environment', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubEnv('NODE_ENV', 'development');
    try {
      const err = new Error('unexpected');
      expect(mapErrorToApiShape(err).statusCode).toBe(500);
      expect(consoleSpy).toHaveBeenCalledWith('APP ERROR:', err);
    } finally {
      vi.unstubAllEnvs();
      consoleSpy.mockRestore();
    }
  });

  it('maps attachment size overflow to 413', () => {
    const err = new multer.MulterError('LIMIT_FILE_SIZE');

    expect(mapErrorToApiShape(err)).toEqual({
      statusCode: 413,
      message: 'Attachment file exceeds the configured size limit',
      code: 'LIMIT_FILE_SIZE',
    });
  });

  it('maps non-size multer errors to 400', () => {
    const err = new multer.MulterError('LIMIT_FILE_COUNT');

    const result = mapErrorToApiShape(err);

    expect(result.statusCode).toBe(400);
    expect(result.code).toBe('LIMIT_FILE_COUNT');
    expect(result.message).toBe(err.message);
  });
});
