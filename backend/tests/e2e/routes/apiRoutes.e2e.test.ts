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

import { resetDb } from '../../helpers/resetDb';
import { testPool } from '../../helpers/testPool';

let app: Express.Application;
let appPool: typeof import('../../../src/db').default;

const registerUser = async (name = 'E2E User') => {
  const email = `e2e-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`;
  const response = await request(app)
    .post('/api/v1/auth/register')
    .send({ email, name, password: 'password123' })
    .expect(201);

  return {
    email,
    token: response.body.token as string,
    userId: response.body.user.userId as string,
  };
};

describe('API routes E2E', () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;
    process.env.CORS_ORIGINS = 'http://allowed.example,http://localhost:3005';
    const indexModule = await import('../../../src/index');
    const dbModule = await import('../../../src/db');
    app = indexModule.app;
    appPool = dbModule.default;
  });

  beforeEach(async () => {
    await resetDb();
  });

  afterAll(async () => {
    await appPool.end();
    await testPool.end();
  });

  it('covers auth routes', async () => {
    const email = `auth-${Date.now()}@example.com`;

    const register = await request(app)
      .post('/api/v1/auth/register')
      .send({ email, name: 'Auth User', password: 'password123' })
      .expect(201);
    expect(register.headers['x-content-type-options']).toBe('nosniff');
    expect(register.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(register.headers['content-security-policy']).toContain("default-src 'self'");
    expect(register.body).toMatchObject({
      token: expect.any(String),
      user: { name: 'Auth User' },
    });
    expect(register.body.user).not.toHaveProperty('passwordHash');

    await request(app)
      .post('/api/v1/auth/login')
      .send({ email, password: 'password123' })
      .expect(200);

    await request(app)
      .post('/api/v1/auth/logout')
      .set('Authorization', `Bearer ${register.body.token}`)
      .expect(204);
  });

  it('only echoes credentialed CORS for configured origins', async () => {
    await request(app)
      .options('/api/v1/users/me')
      .set('Origin', 'http://allowed.example')
      .set('Access-Control-Request-Method', 'GET')
      .expect(204)
      .expect((response) => {
        expect(response.headers['access-control-allow-origin']).toBe('http://allowed.example');
        expect(response.headers['access-control-allow-credentials']).toBe('true');
      });

    await request(app)
      .options('/api/v1/users/me')
      .set('Origin', 'http://evil.example')
      .set('Access-Control-Request-Method', 'GET')
      .expect(204)
      .expect((response) => {
        expect(response.headers['access-control-allow-origin']).toBeUndefined();
      });
  });

  it('covers authenticated user routes', async () => {
    const user = await registerUser('Searchable User');

    await request(app)
      .get('/api/v1/users/me')
      .set('Authorization', `Bearer ${user.token}`)
      .expect(200)
      .expect((response) => {
        expect(response.body).toMatchObject({ userId: user.userId, name: 'Searchable User' });
      });

    await request(app)
      .patch('/api/v1/users/me')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ name: 'Updated User' })
      .expect(200)
      .expect((response) => {
        expect(response.body.name).toBe('Updated User');
      });

    await request(app)
      .get('/api/v1/users?q=Updated')
      .set('Authorization', `Bearer ${user.token}`)
      .expect(200)
      .expect((response) => {
        expect(response.body[0]).toMatchObject({ name: 'Updated User' });
      });
  });

  it('covers room and message routes', async () => {
    const user = await registerUser();

    await request(app)
      .get('/api/v1/rooms')
      .set('Authorization', `Bearer ${user.token}`)
      .expect(200)
      .expect((response) => {
        expect(response.body).toEqual([]);
      });

    const roomResponse = await request(app)
      .post('/api/v1/rooms')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ type: 'group', name: 'E2E Room' })
      .expect(201);
    const roomId = roomResponse.body.roomId as string;

    await request(app)
      .get('/api/v1/rooms')
      .set('Authorization', `Bearer ${user.token}`)
      .expect(200)
      .expect((response) => {
        expect(response.body).toHaveLength(1);
      });

    await request(app)
      .get(`/api/v1/rooms/${roomId}`)
      .set('Authorization', `Bearer ${user.token}`)
      .expect(200)
      .expect((response) => {
        expect(response.body).toMatchObject({ roomId, name: 'E2E Room' });
      });

    await request(app)
      .patch(`/api/v1/rooms/${roomId}`)
      .set('Authorization', `Bearer ${user.token}`)
      .send({ name: 'Renamed E2E Room' })
      .expect(200)
      .expect((response) => {
        expect(response.body.name).toBe('Renamed E2E Room');
      });

    await request(app)
      .post('/api/v1/rooms/fake-id/members')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ inviteCode: 'not-a-code' })
      .expect(404);

    await request(app)
      .delete(`/api/v1/rooms/${roomId}/members/me`)
      .set('Authorization', `Bearer ${user.token}`)
      .expect(403);

    await request(app)
      .get(`/api/v1/rooms/${roomId}/messages`)
      .set('Authorization', `Bearer ${user.token}`)
      .expect(200)
      .expect((response) => {
        expect(response.body).toEqual([]);
      });
  });

  it('rejects unauthenticated protected routes', async () => {
    await request(app).get('/api/v1/users/me').expect(401);
    await request(app).get('/api/v1/rooms').expect(401);
    await request(app).get('/api/v1/rooms/room-1/messages').expect(401);
  });
});
