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

describe('Room E2E', () => {
  let token: string;
  let userId: string;
  let otherToken: string;
  let otherUserId: string;
  let thirdToken: string;

  beforeEach(async () => {
    await resetDb();
    const res = await request(app).post('/api/v1/auth/register').send({
      name: 'User',
      email: 'user@example.com',
      password: 'Password123!',
    });
    token = res.body.token;
    userId = res.body.user.userId;

    const otherRes = await request(app).post('/api/v1/auth/register').send({
      name: 'Other User',
      email: 'other@example.com',
      password: 'Password123!',
    });
    otherToken = otherRes.body.token;
    otherUserId = otherRes.body.user.userId;

    const thirdRes = await request(app).post('/api/v1/auth/register').send({
      name: 'Third User',
      email: 'third@example.com',
      password: 'Password123!',
    });
    thirdToken = thirdRes.body.token;
  });

  const makeFriends = async () => {
    await request(app)
      .post('/api/v1/friend-requests')
      .set('Authorization', `Bearer ${token}`)
      .send({ target_user_id: otherUserId });

    await request(app)
      .patch(`/api/v1/friend-requests/${userId}`)
      .set('Authorization', `Bearer ${otherToken}`)
      .send({ status: 'accepted' });
  };

  it('should create a room', async () => {
    const res = await request(app)
      .post('/api/v1/rooms')
      .set('Authorization', `Bearer ${token}`)
      .send({
        type: 'group',
        name: 'Test Room',
      });
    expect(res.status).toBe(201);
    expect(res.body.roomId).toBeDefined();
    expect(res.body.type).toBe('group');
    expect(res.body.name).toBe('Test Room');
  });

  it('should list rooms', async () => {
    await request(app)
      .post('/api/v1/rooms')
      .set('Authorization', `Bearer ${token}`)
      .send({
        type: 'group',
        name: 'Test Room 1',
      });

    const res = await request(app)
      .get('/api/v1/rooms')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(1);
    expect(res.body[0].name).toBe('Test Room 1');
    expect(res.body[0].unreadCount).toBeDefined();
  });

  it('should create a group with avatar and generated invite code, then join by code', async () => {
    const createRes = await request(app)
      .post('/api/v1/rooms')
      .set('Authorization', `Bearer ${token}`)
      .send({
        type: 'group',
        name: 'Invite Room',
        avatarUrl: 'https://example.com/group.png',
      });

    expect(createRes.status).toBe(201);
    expect(createRes.body.avatarUrl).toBe('https://example.com/group.png');
    expect(createRes.body.inviteCode).toEqual(expect.any(String));

    const joinRes = await request(app)
      .post(`/api/v1/rooms/${createRes.body.roomId}/members`)
      .set('Authorization', `Bearer ${otherToken}`)
      .send({ inviteCode: createRes.body.inviteCode });

    expect(joinRes.status).toBe(200);
    expect(joinRes.body.roomId).toBe(createRes.body.roomId);
  });

  it('should create an idempotent private room for accepted friends', async () => {
    await makeFriends();

    const first = await request(app)
      .post('/api/v1/rooms')
      .set('Authorization', `Bearer ${token}`)
      .send({ type: 'private', target_user_id: otherUserId });
    const second = await request(app)
      .post('/api/v1/rooms')
      .set('Authorization', `Bearer ${token}`)
      .send({ type: 'private', target_user_id: otherUserId });

    expect(first.status).toBe(201); // created on first POST
    expect(first.body.type).toBe('private');
    expect(first.body.roomHash).toBeUndefined();
    expect(second.status).toBe(200);
    expect(second.body.roomId).toBe(first.body.roomId);
    expect(second.body.roomHash).toBeUndefined();

    const ownerRooms = await request(app).get('/api/v1/rooms').set('Authorization', `Bearer ${token}`);
    const otherRooms = await request(app).get('/api/v1/rooms').set('Authorization', `Bearer ${otherToken}`);
    expect(ownerRooms.body.some((room: { roomId: string }) => room.roomId === first.body.roomId)).toBe(true);
    expect(otherRooms.body.some((room: { roomId: string }) => room.roomId === first.body.roomId)).toBe(true);

    const outsider = await request(app)
      .get(`/api/v1/rooms/${first.body.roomId}`)
      .set('Authorization', `Bearer ${thirdToken}`);
    expect(outsider.status).toBe(403);
  });

  it('should reject private room creation when users are blocked', async () => {
    await makeFriends();

    await request(app)
      .post('/api/v1/blocks')
      .set('Authorization', `Bearer ${token}`)
      .send({ target_user_id: otherUserId });

    const res = await request(app)
      .post('/api/v1/rooms')
      .set('Authorization', `Bearer ${token}`)
      .send({ type: 'private', target_user_id: otherUserId });

    expect(res.status).toBe(403);
  });

  it('should permanently delete a group room for the owner', async () => {
    const createRes = await request(app)
      .post('/api/v1/rooms')
      .set('Authorization', `Bearer ${token}`)
      .send({
        type: 'group',
        name: 'Delete Me',
      });

    await request(app)
      .post(`/api/v1/rooms/${createRes.body.roomId}/members`)
      .set('Authorization', `Bearer ${otherToken}`)
      .send({ inviteCode: createRes.body.inviteCode });

    const deleteRes = await request(app)
      .delete(`/api/v1/rooms/${createRes.body.roomId}`)
      .set('Authorization', `Bearer ${token}`);

    expect(deleteRes.status).toBe(204);

    const ownerRooms = await request(app)
      .get('/api/v1/rooms')
      .set('Authorization', `Bearer ${token}`);
    const memberRooms = await request(app)
      .get('/api/v1/rooms')
      .set('Authorization', `Bearer ${otherToken}`);

    expect(ownerRooms.body.some((room: { roomId: string }) => room.roomId === createRes.body.roomId)).toBe(false);
    expect(memberRooms.body.some((room: { roomId: string }) => room.roomId === createRes.body.roomId)).toBe(false);

    const fetchDeleted = await request(app)
      .get(`/api/v1/rooms/${createRes.body.roomId}`)
      .set('Authorization', `Bearer ${token}`);
    expect(fetchDeleted.status).toBe(404);
  });

  it('should upload group avatar successfully by owner', async () => {
    const createRes = await request(app)
      .post('/api/v1/rooms')
      .set('Authorization', `Bearer ${token}`)
      .send({
        type: 'group',
        name: 'Avatar E2E Room',
      });
    expect(createRes.status).toBe(201);
    const roomId = createRes.body.roomId;

    const buffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const uploadRes = await request(app)
      .post(`/api/v1/rooms/${roomId}/avatar`)
      .set('Authorization', `Bearer ${token}`)
      .attach('file', buffer, 'avatar.png');

    expect(uploadRes.status).toBe(200);
    expect(uploadRes.body.avatarUrl).toContain('/uploads/avatars/');

    // Clean up uploaded file
    const fs = await import('fs/promises');
    const path = await import('path');
    const filename = path.basename(uploadRes.body.avatarUrl);
    const filepath = path.resolve(process.cwd(), 'uploads/avatars', filename);
    await fs.unlink(filepath).catch(() => {});
  });

  it('should reject avatar upload by non-admin member', async () => {
    const createRes = await request(app)
      .post('/api/v1/rooms')
      .set('Authorization', `Bearer ${token}`)
      .send({
        type: 'group',
        name: 'Avatar Reject Room',
      });
    const roomId = createRes.body.roomId;

    await request(app)
      .post(`/api/v1/rooms/${roomId}/members`)
      .set('Authorization', `Bearer ${otherToken}`)
      .send({ inviteCode: createRes.body.inviteCode });

    const buffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const uploadRes = await request(app)
      .post(`/api/v1/rooms/${roomId}/avatar`)
      .set('Authorization', `Bearer ${otherToken}`)
      .attach('file', buffer, 'avatar.png');

    expect(uploadRes.status).toBe(403);
  });
});
