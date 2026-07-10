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


import request from 'supertest';
let app: any;
import { resetDb } from '../../helpers/resetDb';

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;
  const indexModule = await import('../../../src/index');
  app = indexModule.app;
});

describe('Auth E2E', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('should register a new user successfully', async () => {
    const res = await request(app).post('/api/v1/auth/register').send({
      name: 'Test User',
      email: 'test@example.com',
      password: 'Password123!',
    });
    if (res.status !== 201) throw new Error("RES: " + JSON.stringify(res.body));
    expect(res.body.token).toBeDefined();
    expect(res.headers['set-cookie']?.join(';')).toContain('refresh_token=');
    expect(res.headers['set-cookie']?.join(';')).toContain('HttpOnly');
    expect(res.headers['set-cookie']?.join(';')).toContain('SameSite=Strict');
    expect(res.body.user).toBeDefined();
    expect(res.body.user.name).toBe('Test User');
  });

  it('should fail registration if email is duplicate', async () => {
    await request(app).post('/api/v1/auth/register').send({
      name: 'Test User',
      email: 'test@example.com',
      password: 'Password123!',
    });
    
    const res = await request(app).post('/api/v1/auth/register').send({
      name: 'Another User',
      email: 'test@example.com',
      password: 'Password123!',
    });
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/duplicate|already exists|already in use/i);
  });

  it('should login an existing user', async () => {
    await request(app).post('/api/v1/auth/register').send({
      name: 'Test User',
      email: 'test@example.com',
      password: 'Password123!',
    });

    const res = await request(app).post('/api/v1/auth/login').send({
      email: 'test@example.com',
      password: 'Password123!',
    });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();
    expect(res.headers['set-cookie']?.join(';')).toContain('refresh_token=');
  });

  it('should authenticate protected routes with the auth header', async () => {
    const register = await request(app).post('/api/v1/auth/register').send({
      name: 'Cookie User',
      email: 'cookie@example.com',
      password: 'Password123!',
    });
    const token = register.body.token;
    const cookie = register.headers['set-cookie'];

    const me = await request(app).get('/api/v1/users/me').set('Authorization', `Bearer ${token}`);
    expect(me.status).toBe(200);
    expect(me.body.name).toBe('Cookie User');

    const logout = await request(app).post('/api/v1/auth/logout').set('Cookie', cookie).set('Authorization', `Bearer ${token}`);
    expect(logout.status).toBe(204);
    expect(logout.headers['set-cookie']?.join(';')).toContain('refresh_token=');
  });

  it('should refresh access token using refresh token cookie', async () => {
    const register = await request(app).post('/api/v1/auth/register').send({
      name: 'Refresh User',
      email: 'refresh@example.com',
      password: 'Password123!',
    });
    const cookie = register.headers['set-cookie'];

    const res = await request(app).post('/api/v1/auth/refresh').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();
    expect(res.headers['set-cookie']?.join(';')).toContain('refresh_token=');
  });

  it('should fail login with incorrect password', async () => {
    await request(app).post('/api/v1/auth/register').send({
      name: 'Test User',
      email: 'test@example.com',
      password: 'Password123!',
    });

    const res = await request(app).post('/api/v1/auth/login').send({
      email: 'test@example.com',
      password: 'WrongPassword!',
    });
    expect(res.status).toBe(400);
  });
});
