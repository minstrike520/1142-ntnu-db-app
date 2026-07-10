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

let app: any;

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;
  const indexModule = await import('../../../src/index');
  app = indexModule.app;
});

describe('Room Members E2E', () => {
  let ownerToken: string;
  let adminToken: string;
  let memberToken: string;
  let pendingToken: string;
  
  let ownerId: string;
  let adminId: string;
  let memberId: string;
  let pendingId: string;
  
  let roomId: string;

  beforeEach(async () => {
    await resetDb();
    
    // Register owner
    let res = await request(app).post('/api/v1/auth/register').send({
      name: 'Owner', email: 'owner@example.com', password: 'Password123!',
    });
    ownerToken = res.body.token;
    ownerId = res.body.user.userId;

    // Register admin
    res = await request(app).post('/api/v1/auth/register').send({
      name: 'Admin', email: 'admin@example.com', password: 'Password123!',
    });
    adminToken = res.body.token;
    adminId = res.body.user.userId;

    // Register member
    res = await request(app).post('/api/v1/auth/register').send({
      name: 'Member', email: 'member@example.com', password: 'Password123!',
    });
    memberToken = res.body.token;
    memberId = res.body.user.userId;
    
    // Register pending
    res = await request(app).post('/api/v1/auth/register').send({
      name: 'Pending', email: 'pending@example.com', password: 'Password123!',
    });
    pendingToken = res.body.token;
    pendingId = res.body.user.userId;

    // Create room
    res = await request(app)
      .post('/api/v1/rooms')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ type: 'group', name: 'Test Room', requireApproval: true });
    roomId = res.body.roomId;

    const { Pool } = await import('pg');
    const pool = new Pool({ connectionString: process.env.DATABASE_URL_TEST });
    
    await pool.query('INSERT INTO room_members (room_id, user_id, role) VALUES ($1, $2, $3)', [roomId, adminId, 'admin']);
    await pool.query('INSERT INTO room_members (room_id, user_id, role) VALUES ($1, $2, $3)', [roomId, memberId, 'member']);
    await pool.query('INSERT INTO room_members (room_id, user_id, role) VALUES ($1, $2, $3)', [roomId, pendingId, 'pending']);
    
    await pool.end();
  });

  describe('POST /rooms/:id/members/:userId/approve', () => {
    it('should allow owner to approve pending member', async () => {
      const res = await request(app)
        .post(`/api/v1/rooms/${roomId}/members/${pendingId}/approve`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
    });

    it('should allow admin to approve pending member', async () => {
      const res = await request(app)
        .post(`/api/v1/rooms/${roomId}/members/${pendingId}/approve`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
    });

    it('should not allow regular member to approve pending member', async () => {
      const res = await request(app)
        .post(`/api/v1/rooms/${roomId}/members/${pendingId}/approve`)
        .set('Authorization', `Bearer ${memberToken}`);
      expect(res.status).toBe(403);
    });
  });

  describe('GET /rooms/:id/members', () => {
    it('should list room members for an existing member', async () => {
      const res = await request(app)
        .get(`/api/v1/rooms/${roomId}/members`)
        .set('Authorization', `Bearer ${memberToken}`);

      expect(res.status).toBe(200);
      expect(res.body.map((member: { userId: string; role: string }) => [member.userId, member.role]))
        .toEqual(expect.arrayContaining([
          [ownerId, 'owner'],
          [adminId, 'admin'],
          [memberId, 'member'],
          [pendingId, 'pending'],
        ]));
    });

    it('should reject non-members', async () => {
      const outsider = await request(app).post('/api/v1/auth/register').send({
        name: 'Outsider', email: 'outsider@example.com', password: 'Password123!',
      });

      const res = await request(app)
        .get(`/api/v1/rooms/${roomId}/members`)
        .set('Authorization', `Bearer ${outsider.body.token}`);

      expect(res.status).toBe(403);
    });
  });

  describe('PATCH /rooms/:id/members/:userId', () => {
    it('should allow owner to change role of member', async () => {
      const res = await request(app)
        .patch(`/api/v1/rooms/${roomId}/members/${memberId}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ role: 'admin' });
      expect(res.status).toBe(200);
    });

    it('should not allow admin to change role', async () => {
      const res = await request(app)
        .patch(`/api/v1/rooms/${roomId}/members/${memberId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ role: 'admin' });
      expect(res.status).toBe(403);
    });
    
    it('should allow admin to mute member', async () => {
      const res = await request(app)
        .patch(`/api/v1/rooms/${roomId}/members/${memberId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ isMuted: true });
      expect(res.status).toBe(200);
    });
  });

  describe('DELETE /rooms/:id/members/:userId', () => {
    it('should allow owner to kick admin', async () => {
      const res = await request(app)
        .delete(`/api/v1/rooms/${roomId}/members/${adminId}`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(204);
    });

    it('should allow admin to kick member', async () => {
      const res = await request(app)
        .delete(`/api/v1/rooms/${roomId}/members/${memberId}`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(204);
    });

    it('should not allow admin to kick owner', async () => {
      const res = await request(app)
        .delete(`/api/v1/rooms/${roomId}/members/${ownerId}`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(403);
    });
  });
});
