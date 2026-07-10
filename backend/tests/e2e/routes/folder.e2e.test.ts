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

describe('Folder E2E', () => {
  let token: string;
  let userId: string;
  let roomId: string;

  beforeEach(async () => {
    await resetDb();
    
    // Create user
    const res = await request(app).post('/api/v1/auth/register').send({
      name: 'User',
      email: 'user@example.com',
      password: 'Password123!',
    });
    token = res.body.token;
    userId = res.body.user.userId;

    // Create room
    const roomRes = await request(app)
      .post('/api/v1/rooms')
      .set('Authorization', `Bearer ${token}`)
      .send({ type: 'group', name: 'Test Room' });
    roomId = roomRes.body.roomId;
  });

  it('should create a new folder', async () => {
    const res = await request(app)
      .post('/api/v1/folders')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'My Folder' });
    expect(res.status).toBe(201);
    expect(res.body.folderId).toBeDefined();
    expect(res.body.name).toBe('My Folder');
  });

  it('should list folders', async () => {
    await request(app)
      .post('/api/v1/folders')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Folder 1' });

    const res = await request(app)
      .get('/api/v1/folders')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toBeInstanceOf(Array);
    expect(res.body.length).toBe(1);
    expect(res.body[0].name).toBe('Folder 1');
    expect(res.body[0].roomIds).toEqual([]);
  });

  it('should delete a folder', async () => {
    const createRes = await request(app)
      .post('/api/v1/folders')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Folder to Delete' });
    const folderId = createRes.body.folderId;

    const deleteRes = await request(app)
      .delete(`/api/v1/folders/${folderId}`)
      .set('Authorization', `Bearer ${token}`);
    expect(deleteRes.status).toBe(204);

    const getRes = await request(app)
      .get('/api/v1/folders')
      .set('Authorization', `Bearer ${token}`);
    expect(getRes.body.length).toBe(0);
  });

  it('should move rooms into a folder', async () => {
    const createRes = await request(app)
      .post('/api/v1/folders')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Folder with Rooms' });
    const folderId = createRes.body.folderId;

    const moveRes = await request(app)
      .put(`/api/v1/folders/${folderId}/rooms`)
      .set('Authorization', `Bearer ${token}`)
      .send({ roomIds: [roomId] });
    expect(moveRes.status).toBe(200);

    const getRes = await request(app)
      .get('/api/v1/folders')
      .set('Authorization', `Bearer ${token}`);
    expect(getRes.body[0].roomIds).toContain(roomId);
  });

  it('should reject moving rooms the user does not belong to into a folder', async () => {
    const otherUser = await request(app).post('/api/v1/auth/register').send({
      name: 'Other User',
      email: 'other@example.com',
      password: 'Password123!',
    });

    const otherRoom = await request(app)
      .post('/api/v1/rooms')
      .set('Authorization', `Bearer ${otherUser.body.token}`)
      .send({ type: 'group', name: 'Other Room' });

    const createRes = await request(app)
      .post('/api/v1/folders')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Secure Folder' });

    const moveRes = await request(app)
      .put(`/api/v1/folders/${createRes.body.folderId}/rooms`)
      .set('Authorization', `Bearer ${token}`)
      .send({ roomIds: [otherRoom.body.roomId] });

    expect(moveRes.status).toBe(403);
  });
});
