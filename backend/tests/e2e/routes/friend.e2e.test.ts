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

describe('Friendships & Blocks E2E', () => {
  let tokenA: string;
  let userA: { userId: string; name: string };
  let tokenB: string;
  let userB: { userId: string; name: string };
  let tokenC: string;
  let userC: { userId: string; name: string };

  beforeEach(async () => {
    await resetDb();

    // Create User A
    const resA = await request(app).post('/api/v1/auth/register').send({
      name: 'User A',
      email: 'a@example.com',
      password: 'Password123!',
    });
    tokenA = resA.body.token;
    userA = resA.body.user;

    // Create User B
    const resB = await request(app).post('/api/v1/auth/register').send({
      name: 'User B',
      email: 'b@example.com',
      password: 'Password123!',
    });
    tokenB = resB.body.token;
    userB = resB.body.user;

    // Create User C
    const resC = await request(app).post('/api/v1/auth/register').send({
      name: 'User C',
      email: 'c@example.com',
      password: 'Password123!',
    });
    tokenC = resC.body.token;
    userC = resC.body.user;
  });

  describe('Friendships', () => {
    it('should send a friend request successfully', async () => {
      const res = await request(app)
        .post('/api/v1/friend-requests')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ target_user_id: userB.userId });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('pending');
    });

    it('should fail if sending a request to oneself', async () => {
      const res = await request(app)
        .post('/api/v1/friend-requests')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ target_user_id: userA.userId });

      expect(res.status).toBe(400);
    });

    it('should list pending friend requests', async () => {
      await request(app)
        .post('/api/v1/friend-requests')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ target_user_id: userB.userId });

      const res = await request(app)
        .get('/api/v1/friend-requests')
        .set('Authorization', `Bearer ${tokenB}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBe(1);
      expect(res.body[0].requesterId).toBe(userA.userId);
    });

    it('should accept a friend request', async () => {
      // A sends request to B
      await request(app)
        .post('/api/v1/friend-requests')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ target_user_id: userB.userId });

      // B accepts
      const res = await request(app)
        .patch(`/api/v1/friend-requests/${userA.userId}`)
        .set('Authorization', `Bearer ${tokenB}`)
        .send({ status: 'accepted' });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('accepted');

      // Check friends list for B
      const listRes = await request(app)
        .get('/api/v1/friends')
        .set('Authorization', `Bearer ${tokenB}`);
      
      expect(listRes.status).toBe(200);
      expect(listRes.body.length).toBe(1);
      expect(listRes.body[0].friend.userId).toBe(userA.userId);

      // accepting the request does NOT auto-create the private room anymore
      const roomsBeforeOpen = await request(app).get('/api/v1/rooms').set('Authorization', `Bearer ${tokenA}`);
      expect(roomsBeforeOpen.body.some((room: { type: string }) => room.type === 'private')).toBe(false);

      const openRoom = await request(app)
        .post('/api/v1/rooms')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ type: 'private', targetUserId: userB.userId });
      expect(openRoom.status).toBe(201); // created for the first time

      const roomsB = await request(app).get('/api/v1/rooms').set('Authorization', `Bearer ${tokenB}`);
      const privateRoomB = roomsB.body.find((room: { type: string }) => room.type === 'private');
      expect(privateRoomB?.roomId).toBe(openRoom.body.roomId);
    });

    it('should mark the private room read-only when friendship is removed', async () => {
      await request(app)
        .post('/api/v1/friend-requests')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ target_user_id: userB.userId });
      await request(app)
        .patch(`/api/v1/friend-requests/${userA.userId}`)
        .set('Authorization', `Bearer ${tokenB}`)
        .send({ status: 'accepted' });

      const privateRoom = await request(app)
        .post('/api/v1/rooms')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ type: 'private', targetUserId: userB.userId });
      expect(privateRoom.status).toBe(201); // created for the first time

      const deleteRes = await request(app)
        .delete(`/api/v1/friends/${userB.userId}`)
        .set('Authorization', `Bearer ${tokenA}`);
      expect(deleteRes.status).toBe(204);

      const row = await testPool.query('SELECT is_readonly FROM chat_rooms WHERE room_id = $1', [privateRoom.body.roomId]);
      expect(row.rows[0].is_readonly).toBe(true);
    });
    it('should reject a friend request and not affect accepted friendships', async () => {
      // C sends request to B
      await request(app)
        .post('/api/v1/friend-requests')
        .set('Authorization', `Bearer ${tokenC}`)
        .send({ target_user_id: userB.userId });

      // B accepts C
      await request(app)
        .patch(`/api/v1/friend-requests/${userC.userId}`)
        .set('Authorization', `Bearer ${tokenB}`)
        .send({ status: 'accepted' });

      // A sends request to B
      await request(app)
        .post('/api/v1/friend-requests')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ target_user_id: userB.userId });

      // B rejects A
      const res = await request(app)
        .patch(`/api/v1/friend-requests/${userA.userId}`)
        .set('Authorization', `Bearer ${tokenB}`)
        .send({ status: 'rejected' });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('rejected');

      // Check friends list for B, C should still be there
      const listRes = await request(app)
        .get('/api/v1/friends')
        .set('Authorization', `Bearer ${tokenB}`);
      
      expect(listRes.status).toBe(200);
      expect(listRes.body.length).toBe(1);
      expect(listRes.body[0].friend.userId).toBe(userC.userId);
    });
  });

  describe('Blocks', () => {
    it('should block a user', async () => {
      const res = await request(app)
        .post('/api/v1/blocks')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ target_user_id: userC.userId });

      expect(res.status).toBe(201);
    });

    it('should not allow sending a friend request to a blocked user', async () => {
      // A blocks C
      await request(app)
        .post('/api/v1/blocks')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ target_user_id: userC.userId });

      // C tries to friend A
      const res = await request(app)
        .post('/api/v1/friend-requests')
        .set('Authorization', `Bearer ${tokenC}`)
        .send({ target_user_id: userA.userId });

      expect(res.status).toBe(403);
    });

    it('should mark existing private room read-only when blocking a friend', async () => {
      await request(app)
        .post('/api/v1/friend-requests')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ target_user_id: userB.userId });
      await request(app)
        .patch(`/api/v1/friend-requests/${userA.userId}`)
        .set('Authorization', `Bearer ${tokenB}`)
        .send({ status: 'accepted' });

      const privateRoom = await request(app)
        .post('/api/v1/rooms')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ type: 'private', targetUserId: userB.userId });
      expect(privateRoom.status).toBe(201); // created for the first time

      const blockRes = await request(app)
        .post('/api/v1/blocks')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ target_user_id: userB.userId });

      expect(blockRes.status).toBe(201);
      const row = await testPool.query('SELECT is_readonly FROM chat_rooms WHERE room_id = $1', [privateRoom.body.roomId]);
      expect(row.rows[0].is_readonly).toBe(true);
    });

    it('should restore the friendship after unblocking a blocked friend', async () => {
      await request(app)
        .post('/api/v1/friend-requests')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ target_user_id: userB.userId });
      await request(app)
        .patch(`/api/v1/friend-requests/${userA.userId}`)
        .set('Authorization', `Bearer ${tokenB}`)
        .send({ status: 'accepted' });

      const privateRoom = await request(app)
        .post('/api/v1/rooms')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ type: 'private', targetUserId: userB.userId });
      expect(privateRoom.status).toBe(201);

      const blockRes = await request(app)
        .post('/api/v1/blocks')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ target_user_id: userB.userId });
      expect(blockRes.status).toBe(201);

      const blockedFriends = await request(app)
        .get('/api/v1/friends')
        .set('Authorization', `Bearer ${tokenA}`);
      expect(blockedFriends.status).toBe(200);
      expect(blockedFriends.body).toEqual([]);

      const unblockRes = await request(app)
        .delete(`/api/v1/blocks/${userB.userId}`)
        .set('Authorization', `Bearer ${tokenA}`);
      expect(unblockRes.status).toBe(204);

      const restoredFriends = await request(app)
        .get('/api/v1/friends')
        .set('Authorization', `Bearer ${tokenA}`);
      expect(restoredFriends.status).toBe(200);
      expect(restoredFriends.body).toHaveLength(1);
      expect(restoredFriends.body[0].friend.userId).toBe(userB.userId);

      const row = await testPool.query('SELECT is_readonly FROM chat_rooms WHERE room_id = $1', [privateRoom.body.roomId]);
      expect(row.rows[0].is_readonly).toBe(false);
    });

    it('should list blocked users', async () => {
      // A blocks C (done in earlier test, but tests might not be perfectly isolated, let's block C if not blocked or use B)
      await request(app)
        .post('/api/v1/blocks')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ target_user_id: userC.userId });

      const listRes = await request(app)
        .get('/api/v1/blocks')
        .set('Authorization', `Bearer ${tokenA}`);

      expect(listRes.status).toBe(200);
      expect(Array.isArray(listRes.body)).toBe(true);
      expect(listRes.body.length).toBeGreaterThan(0);
      expect(listRes.body[0]).toHaveProperty('userId');
      expect(listRes.body[0]).toHaveProperty('name');
      expect(listRes.body[0]).toHaveProperty('email');
    });
  });
});
