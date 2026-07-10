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
import { app } from '../../../src/index';
import { resetDb } from '../../helpers/resetDb';
import { testPool } from '../../helpers/testPool';

describe('Emergency Contacts E2E', () => {
  let token1: string;
  let user1Id: string;
  let user2Id: string;

  beforeEach(async () => {
    await resetDb();
    
    // Register User 1
    const res1 = await request(app).post('/api/v1/auth/register').send({
      name: 'User One',
      email: 'user1@example.com',
      password: 'Password123!',
    });
    token1 = res1.body.token;
    user1Id = res1.body.user.userId;

    // Register User 2
    const res2 = await request(app).post('/api/v1/auth/register').send({
      name: 'User Two',
      email: 'user2@example.com',
      password: 'Password123!',
    });
    user2Id = res2.body.user.userId;
  });

  it('should create an emergency contact', async () => {
    const res = await request(app)
      .post('/api/v1/users/me/emergency-contacts')
      .set('Authorization', `Bearer ${token1}`)
      .send({
        contactId: user2Id,
        message: 'Help me!',
      });
    
    expect(res.status).toBe(201);
    expect(res.body.contactId).toBe(user2Id);
    expect(res.body.message).toBe('Help me!');
  });

  it('should get emergency contacts', async () => {
    await request(app)
      .post('/api/v1/users/me/emergency-contacts')
      .set('Authorization', `Bearer ${token1}`)
      .send({
        contactId: user2Id,
        message: 'Help me!',
      });

    const res = await request(app)
      .get('/api/v1/users/me/emergency-contacts')
      .set('Authorization', `Bearer ${token1}`);
    
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].contactId).toBe(user2Id);
    expect(res.body[0].message).toBe('Help me!');
    expect(res.body[0].contact).toBeDefined();
    expect(res.body[0].contact.name).toBe('User Two');
  });

  it('should update an emergency contact if already exists', async () => {
    await request(app)
      .post('/api/v1/users/me/emergency-contacts')
      .set('Authorization', `Bearer ${token1}`)
      .send({
        contactId: user2Id,
        message: 'Initial message',
      });

    const res = await request(app)
      .post('/api/v1/users/me/emergency-contacts')
      .set('Authorization', `Bearer ${token1}`)
      .send({
        contactId: user2Id,
        message: 'Updated message',
      });

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Updated message');
  });

  it('should delete an emergency contact', async () => {
    await request(app)
      .post('/api/v1/users/me/emergency-contacts')
      .set('Authorization', `Bearer ${token1}`)
      .send({
        contactId: user2Id,
        message: 'Help me!',
      });

    const delRes = await request(app)
      .delete(`/api/v1/users/me/emergency-contacts/${user2Id}`)
      .set('Authorization', `Bearer ${token1}`);
    
    expect(delRes.status).toBe(200);

    const getRes = await request(app)
      .get('/api/v1/users/me/emergency-contacts')
      .set('Authorization', `Bearer ${token1}`);
    
    expect(getRes.body).toHaveLength(0);
  });


  it('should check inactivity threshold and suppress duplicate alerts', async () => {
    await request(app)
      .post('/api/v1/users/me/emergency-contacts')
      .set('Authorization', `Bearer ${token1}`)
      .send({
        contactId: user2Id,
        message: 'Legacy check message',
      });

    await testPool.query(
      `UPDATE users
       SET warning_enabled = true,
           warning_days = 2,
           last_activity = '2026-01-01T00:00:00.000Z'
       WHERE user_id = $1`,
      [user1Id],
    );

    const belowThreshold = await request(app)
      .post('/api/v1/users/me/emergency-alert/check-inactivity')
      .set('Authorization', `Bearer ${token1}`)
      .send({ now: '2026-01-02T00:00:00.000Z' });
    expect(belowThreshold.status).toBe(200);
    expect(belowThreshold.body).toMatchObject({ alerted: false, reason: 'BELOW_THRESHOLD' });

    const firstAlert = await request(app)
      .post('/api/v1/users/me/emergency-alert/check-inactivity')
      .set('Authorization', `Bearer ${token1}`)
      .send({ now: '2026-01-04T00:00:00.000Z' });
    expect(firstAlert.status).toBe(200);
    expect(firstAlert.body).toEqual({ alerted: true, recipients: [user2Id] });

    const duplicate = await request(app)
      .post('/api/v1/users/me/emergency-alert/check-inactivity')
      .set('Authorization', `Bearer ${token1}`)
      .send({ now: '2026-01-04T00:00:00.000Z' });
    expect(duplicate.status).toBe(200);
    expect(duplicate.body).toMatchObject({ alerted: false, reason: 'ALREADY_ALERTED' });
  });
});
