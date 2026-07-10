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


import { RoomMemberRepository } from '../../../src/repositories/roomMemberRepository';
import { testPool } from '../../helpers/testPool';
import { resetDb } from '../../helpers/resetDb';

describe('RoomMemberRepository (pg)', () => {
  const repo = new RoomMemberRepository(testPool);

  beforeEach(async () => {
    await resetDb();
  });

  async function createUser(name: string, email: string) {
    const res = await testPool.query(
      'INSERT INTO users (name, email, password_hash) VALUES ($1, $2, $3) RETURNING user_id',
      [name, email, 'hash'],
    );
    return res.rows[0].user_id as string;
  }

  async function createRoom() {
    const res = await testPool.query(
      'INSERT INTO chat_rooms (type, name) VALUES ($1, $2) RETURNING room_id',
      ['group', 'Room Member Repo Room'],
    );
    return res.rows[0].room_id as string;
  }

  async function createMessage(roomId: string, userId: string) {
    const res = await testPool.query(
      'INSERT INTO messages (room_id, sender_id, content) VALUES ($1, $2, $3) RETURNING message_id',
      [roomId, userId, 'read marker'],
    );
    return res.rows[0].message_id as string;
  }

  it('add -> findMember -> findByRoom -> remove manages membership records', async () => {
    const ownerId = await createUser('Owner', 'owner@test.com');
    const memberId = await createUser('Member', 'member@test.com');
    const roomId = await createRoom();

    const owner = await repo.add({ roomId, userId: ownerId, role: 'owner' });
    await repo.add({ roomId, userId: memberId, role: 'member' });

    expect(owner.roomId).toBe(roomId);
    expect(owner.userId).toBe(ownerId);
    expect(owner.role).toBe('owner');
    expect(owner.isMuted).toBe(false);
    expect(owner.joinTime).toBeInstanceOf(Date);

    const fetched = await repo.findMember(roomId, ownerId);
    expect(fetched).toEqual(owner);

    const members = await repo.findByRoom(roomId);
    expect(members).toHaveLength(2);
    expect(members.map((member) => member.userId)).toContain(ownerId);
    expect(members.map((member) => member.userId)).toContain(memberId);

    await repo.remove(roomId, memberId);
    const removed = await repo.findMember(roomId, memberId);
    expect(removed).toBeNull();
    await repo.remove(roomId, memberId);
  });

  it('update changes role, nickname, muted state, and lastReadId', async () => {
    const userId = await createUser('Reader', 'reader@test.com');
    const roomId = await createRoom();
    const messageId = await createMessage(roomId, userId);
    await repo.add({ roomId, userId, role: 'member' });

    const updated = await repo.update(roomId, userId, {
      role: 'admin',
      nickname: 'Project Lead',
      isMuted: true,
      lastReadId: messageId,
    });

    expect(updated.role).toBe('admin');
    expect(updated.nickname).toBe('Project Lead');
    expect(updated.isMuted).toBe(true);
    expect(updated.lastReadId).toBe(messageId);

    const noChange = await repo.update(roomId, userId, {});
    expect(noChange).toEqual(updated);
  });

  it('findMember returns null and update throws when membership is missing', async () => {
    const userId = await createUser('Missing', 'missing@test.com');
    const roomId = await createRoom();

    const missing = await repo.findMember(roomId, userId);
    expect(missing).toBeNull();

    await expect(repo.update(roomId, userId, { isMuted: true })).rejects.toThrow(
      'Room member not found',
    );
  });
});
