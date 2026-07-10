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


import { RoomRepository } from '../../../src/repositories/roomRepository';
import { testPool } from '../../helpers/testPool';
import { resetDb } from '../../helpers/resetDb';

describe('RoomRepository (pg)', () => {
  const repo = new RoomRepository(testPool);

  beforeEach(async () => {
    await resetDb();
  });

  afterAll(async () => {
    await testPool.end();
  });

  it('create → findById → findByMember → update → delete', async () => {
    // create a user so we can add a room member
    const userRes = await testPool.query(
      "INSERT INTO users (name, email, password_hash) VALUES ('Alice', 'alice@test.com', 'hash') RETURNING user_id"
    );
    const userId: string = userRes.rows[0].user_id;

    // create
    const room = await repo.create({
      type: 'group',
      name: 'Study Room',
      requireApproval: false,
      viewHistory: true,
    });

    expect(typeof room.roomId).toBe('string');
    expect(room.type).toBe('group');
    expect(room.name).toBe('Study Room');
    expect(room.requireApproval).toBe(false);
    expect(room.viewHistory).toBe(true);
    expect(room.isArchived).toBe(false);
    expect(room.createdAt).toBeInstanceOf(Date);

    // findById
    const fetched = await repo.findById(room.roomId);
    expect(fetched).toEqual(room);

    // findByMember — add membership first, then verify room appears
    await testPool.query(
      'INSERT INTO room_members (room_id, user_id, role) VALUES ($1, $2, $3)',
      [room.roomId, userId, 'owner']
    );
    const rooms = await repo.findByMember(userId);
    expect(rooms).toHaveLength(1);
    expect(rooms[0].roomId).toBe(room.roomId);

    // update
    const updated = await repo.update(room.roomId, {
      name: 'Updated Room',
      isArchived: true,
    });
    expect(updated.name).toBe('Updated Room');
    expect(updated.isArchived).toBe(true);
    expect(updated.roomId).toBe(room.roomId);

    const afterUpdate = await repo.findById(room.roomId);
    expect(afterUpdate).toEqual(updated);

    // delete
    await repo.delete(room.roomId);
    const afterDelete = await repo.findById(room.roomId);
    expect(afterDelete).toBeNull();
  });

  it('findById returns null for non-existent room', async () => {
    const result = await repo.findById('00000000-0000-0000-0000-000000000000');
    expect(result).toBeNull();
  });

  it('findByMember returns empty array when user has no rooms', async () => {
    const userRes = await testPool.query(
      "INSERT INTO users (name, email, password_hash) VALUES ('Bob', 'bob@test.com', 'hash') RETURNING user_id"
    );
    const result = await repo.findByMember(userRes.rows[0].user_id);
    expect(result).toEqual([]);
  });

  it('create accepts type="private"', async () => {
    const room = await repo.create({
      type: 'private',
      name: undefined,
      requireApproval: false,
      viewHistory: false,
    });
    expect(room.type).toBe('private');
    expect(typeof room.roomId).toBe('string');
  });

  it('findByMember unreadCount logic: unread count correctly reflects read status', async () => {
    const user1Res = await testPool.query(
      "INSERT INTO users (name, email, password_hash) VALUES ('Alice', 'alice@test.com', 'hash') RETURNING user_id"
    );
    const user2Res = await testPool.query(
      "INSERT INTO users (name, email, password_hash) VALUES ('Bob', 'bob@test.com', 'hash') RETURNING user_id"
    );
    const aliceId = user1Res.rows[0].user_id;
    const bobId = user2Res.rows[0].user_id;

    const room = await repo.create({
      type: 'group',
      name: 'Group Chat',
      requireApproval: false,
      viewHistory: true,
    });

    await testPool.query(
      'INSERT INTO room_members (room_id, user_id, role) VALUES ($1, $2, $3), ($1, $4, $5)',
      [room.roomId, aliceId, 'owner', bobId, 'member']
    );

    // 1. Bob sends a message, Alice's last_read_id is NULL (unread count should be 1)
    const msg1Res = await testPool.query(
      'INSERT INTO messages (room_id, sender_id, content) VALUES ($1, $2, $3) RETURNING message_id',
      [room.roomId, bobId, 'Hello from Bob']
    );
    const msg1Id = msg1Res.rows[0].message_id;

    let rooms = await repo.findByMember(aliceId);
    expect(rooms).toHaveLength(1);
    expect(rooms[0].unreadCount).toBe(1);

    // 2. Alice updates last_read_id to Bob's message (unread count should be 0)
    await testPool.query(
      'UPDATE room_members SET last_read_id = $1 WHERE room_id = $2 AND user_id = $3',
      [msg1Id, room.roomId, aliceId]
    );
    rooms = await repo.findByMember(aliceId);
    expect(rooms[0].unreadCount).toBe(0);

    // 3. Alice sends a message, and updates her last_read_id to her own message (unread count should be 0)
    const msg2Res = await testPool.query(
      'INSERT INTO messages (room_id, sender_id, content) VALUES ($1, $2, $3) RETURNING message_id',
      [room.roomId, aliceId, 'Hello from Alice']
    );
    const msg2Id = msg2Res.rows[0].message_id;

    await testPool.query(
      'UPDATE room_members SET last_read_id = $1 WHERE room_id = $2 AND user_id = $3',
      [msg2Id, room.roomId, aliceId]
    );
    rooms = await repo.findByMember(aliceId);
    expect(rooms[0].unreadCount).toBe(0);
  });
});
