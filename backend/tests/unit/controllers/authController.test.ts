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


import { makeAuthController } from '../../../src/controllers/authController';
import { ValidationError } from '../../../src/errors/AppError';
import type { Request, Response, NextFunction } from 'express';

const mockRes = () => {
  const res = { status: vi.fn(), json: vi.fn(), send: vi.fn(), cookie: vi.fn(), clearCookie: vi.fn() } as any;
  res.status.mockReturnValue(res);
  return res;
};

describe('authController', () => {
  const authResult = { token: 'tok', refreshToken: 'fake-refresh-token', user: { userId: 'u1', email: 'alice@example.com', name: 'Alice' } };
  const service = { register: vi.fn(), login: vi.fn(), refresh: vi.fn(), revokeToken: vi.fn() };
  const ctrl = makeAuthController(service);

  beforeEach(() => vi.clearAllMocks());

  describe('register', () => {
    it('returns 201 on valid input', async () => {
      service.register.mockResolvedValue(authResult);
      const req = { body: { email: 'alice@example.com', name: 'Alice', password: 'password123' } } as Request;
      const res = mockRes();
      const next = vi.fn();

      await ctrl.register(req, res, next);

      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.cookie).toHaveBeenCalledWith(
        'refresh_token',
        'fake-refresh-token',
        expect.objectContaining({ httpOnly: true, secure: false, sameSite: 'strict' }),
      );
      expect(res.json).toHaveBeenCalledWith({
        token: 'tok',
        user: authResult.user
      });
      expect(next).not.toHaveBeenCalled();
    });

    it('calls next with ValidationError on invalid body', async () => {
      const req = { body: { email: 'not-an-email', name: 'Alice', password: 'short' } } as Request;
      const res = mockRes();
      const next = vi.fn();

      await ctrl.register(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.any(ValidationError));
      expect(res.status).not.toHaveBeenCalled();
    });

    it('calls next with error when service throws', async () => {
      const err = new Error('conflict');
      service.register.mockRejectedValue(err);
      const req = { body: { email: 'alice@example.com', name: 'Alice', password: 'password123' } } as Request;
      const res = mockRes();
      const next = vi.fn();

      await ctrl.register(req, res, next);

      expect(next).toHaveBeenCalledWith(err);
    });
  });

  describe('login', () => {
    it('returns 200 on valid input', async () => {
      service.login.mockResolvedValue(authResult);
      const req = { body: { email: 'alice@example.com', password: 'password123' } } as Request;
      const res = mockRes();
      const next = vi.fn();

      await ctrl.login(req, res, next);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.cookie).toHaveBeenCalledWith(
        'refresh_token',
        'fake-refresh-token',
        expect.objectContaining({ httpOnly: true, secure: false, sameSite: 'strict' }),
      );
      expect(res.json).toHaveBeenCalledWith({
        token: 'tok',
        user: authResult.user
      });
      expect(next).not.toHaveBeenCalled();
    });

    it('calls next with ValidationError on missing fields', async () => {
      const req = { body: {} } as Request;
      const res = mockRes();
      const next = vi.fn();

      await ctrl.login(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.any(ValidationError));
    });

    it('calls next with error when service throws', async () => {
      const err = new Error('unauthorized');
      service.login.mockRejectedValue(err);
      const req = { body: { email: 'alice@example.com', password: 'password123' } } as Request;
      const res = mockRes();
      const next = vi.fn();

      await ctrl.login(req, res, next);

      expect(next).toHaveBeenCalledWith(err);
    });
  });

  describe('logout', () => {
    it('returns 204', async () => {
      const req = { headers: { cookie: 'refresh_token=fake-refresh-token' } } as Request;
      const res = mockRes();
      const next = vi.fn();

      await ctrl.logout(req, res, next);

      expect(service.revokeToken).toHaveBeenCalledWith('fake-refresh-token');
      expect(res.clearCookie).toHaveBeenCalledWith(
        'refresh_token',
        expect.objectContaining({ httpOnly: true, secure: false, sameSite: 'strict' }),
      );
      expect(res.status).toHaveBeenCalledWith(204);
      expect(res.send).toHaveBeenCalled();
    });

    it('skips revokeToken but still clears cookie and sends 204 when no cookie is present', async () => {
      const req = { headers: {} } as Request;
      const res = mockRes();
      const next = vi.fn();

      await ctrl.logout(req, res, next);

      expect(service.revokeToken).not.toHaveBeenCalled();
      expect(res.clearCookie).toHaveBeenCalledWith(
        'refresh_token',
        expect.objectContaining({ httpOnly: true, secure: false, sameSite: 'strict' }),
      );
      expect(res.status).toHaveBeenCalledWith(204);
      expect(res.send).toHaveBeenCalled();
    });

    it('calls next with error when revokeToken throws', async () => {
      const err = new Error('revoke failed');
      service.revokeToken.mockRejectedValue(err);
      const req = { headers: { cookie: 'refresh_token=some-token' } } as Request;
      const res = mockRes();
      const next = vi.fn();

      await ctrl.logout(req, res, next);

      expect(next).toHaveBeenCalledWith(err);
      expect(res.status).not.toHaveBeenCalled();
    });
  });

  describe('refresh', () => {
    it('returns 200 and a new access token on valid refresh token', async () => {
      service.refresh.mockResolvedValue({
        token: 'new-tok',
        refreshToken: 'new-fake-refresh-token',
        user: authResult.user
      });
      const req = { headers: { cookie: 'refresh_token=old-refresh-token' } } as Request;
      const res = mockRes();
      const next = vi.fn();

      await ctrl.refresh(req, res, next);

      expect(service.refresh).toHaveBeenCalledWith('old-refresh-token');
      expect(res.cookie).toHaveBeenCalledWith(
        'refresh_token',
        'new-fake-refresh-token',
        expect.objectContaining({ httpOnly: true, secure: false, sameSite: 'strict' }),
      );
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({
        token: 'new-tok',
        user: authResult.user
      });
    });

    it('calls next with ValidationError when cookie is missing', async () => {
      const req = { headers: {} } as Request;
      const res = mockRes();
      const next = vi.fn();

      await ctrl.refresh(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.any(ValidationError));
      expect(res.status).not.toHaveBeenCalled();
    });

    it('clears cookie and calls next when the token is rejected', async () => {
      const err = new ValidationError('invalid token');
      service.refresh.mockRejectedValue(err);
      const req = { headers: { cookie: 'refresh_token=bad-token' } } as Request;
      const res = mockRes();
      const next = vi.fn();

      await ctrl.refresh(req, res, next);

      expect(res.clearCookie).toHaveBeenCalledWith(
        'refresh_token',
        expect.objectContaining({ httpOnly: true, secure: false, sameSite: 'strict' }),
      );
      expect(next).toHaveBeenCalledWith(err);
    });

    it('keeps the cookie when the service throws an unexpected error', async () => {
      const err = new Error('database unavailable');
      service.refresh.mockRejectedValue(err);
      const req = { headers: { cookie: 'refresh_token=valid-token' } } as Request;
      const res = mockRes();
      const next = vi.fn();

      await ctrl.refresh(req, res, next);

      expect(res.clearCookie).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalledWith(err);
    });
  });
});
