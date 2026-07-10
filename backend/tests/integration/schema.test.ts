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


import { testPool } from '../helpers/testPool';
import { resetDb } from '../helpers/resetDb';

describe('Database Schema & Constraints', () => {
  beforeEach(async () => {
    await resetDb();
  });

  describe('users table constraints', () => {
    it('should successfully insert a user and hash password', async () => {
      const res = await testPool.query(
        `INSERT INTO users (name, email, password_hash) 
         VALUES ('Alice', 'alice@test.com', 'hashedpassword') 
         RETURNING user_id, warning_enabled, warning_days, lang_preference`
      );
      expect(res.rows[0].user_id).toBeDefined();
      expect(res.rows[0].warning_enabled).toBe(false); // Default value
      expect(res.rows[0].warning_days).toBe(0); // Default value
      expect(res.rows[0].lang_preference).toBe('en'); // Default value
    });

    it('should prevent inserting duplicate emails', async () => {
      await testPool.query(
        "INSERT INTO users (name, email, password_hash) VALUES ('Alice', 'alice@test.com', 'hash')"
      );
      await expect(
        testPool.query(
          "INSERT INTO users (name, email, password_hash) VALUES ('Bob', 'alice@test.com', 'hash')"
        )
      ).rejects.toThrow(/unique constraint/i);
    });
  });

  describe('chat_rooms table constraints', () => {
    it('should allow valid room types ("private" and "group")', async () => {
      const res1 = await testPool.query(
        "INSERT INTO chat_rooms (type, name) VALUES ('private', 'Direct Message') RETURNING room_id"
      );
      const res2 = await testPool.query(
        "INSERT INTO chat_rooms (type, name) VALUES ('group', 'DB Study Group') RETURNING room_id"
      );
      expect(res1.rows[0].room_id).toBeDefined();
      expect(res2.rows[0].room_id).toBeDefined();
    });

    it('should reject invalid room types', async () => {
      await expect(
        testPool.query("INSERT INTO chat_rooms (type) VALUES ('invalid')")
      ).rejects.toThrow(/check constraint/i);
    });
  });

  describe('room_members table constraints', () => {
    it('should allow valid roles ("owner", "admin", "member", "pending")', async () => {
      const userRes = await testPool.query(
        "INSERT INTO users (name, email, password_hash) VALUES ('User', 'user@test.com', 'hash') RETURNING user_id"
      );
      const userId = userRes.rows[0].user_id;

      const roomRes = await testPool.query(
        "INSERT INTO chat_rooms (type) VALUES ('private') RETURNING room_id"
      );
      const roomId = roomRes.rows[0].room_id;

      const memberRes = await testPool.query(
        `INSERT INTO room_members (room_id, user_id, role) 
         VALUES ($1, $2, 'owner') RETURNING role`,
        [roomId, userId]
      );
      expect(memberRes.rows[0].role).toBe('owner');
    });

    it('should reject invalid member roles', async () => {
      const userRes = await testPool.query(
        "INSERT INTO users (name, email, password_hash) VALUES ('User', 'user@test.com', 'hash') RETURNING user_id"
      );
      const userId = userRes.rows[0].user_id;

      const roomRes = await testPool.query(
        "INSERT INTO chat_rooms (type) VALUES ('private') RETURNING room_id"
      );
      const roomId = roomRes.rows[0].room_id;

      await expect(
        testPool.query(
          `INSERT INTO room_members (room_id, user_id, role) VALUES ($1, $2, 'superuser')`,
          [roomId, userId]
        )
      ).rejects.toThrow(/check constraint/i);
    });
  });

  describe('Foreign Key Constraints and Cascades', () => {
    let userId: string;
    let roomId: string;

    beforeEach(async () => {
      const userRes = await testPool.query(
        "INSERT INTO users (name, email, password_hash) VALUES ('Alice', 'alice@test.com', 'hash') RETURNING user_id"
      );
      userId = userRes.rows[0].user_id;

      const roomRes = await testPool.query(
        "INSERT INTO chat_rooms (type) VALUES ('group') RETURNING room_id"
      );
      roomId = roomRes.rows[0].room_id;

      await testPool.query(
        "INSERT INTO room_members (room_id, user_id, role) VALUES ($1, $2, 'owner')",
        [roomId, userId]
      );
    });

    it('should delete room memberships when a room is deleted (ON DELETE CASCADE)', async () => {
      // Confirm member exists
      const beforeCount = await testPool.query(
        "SELECT COUNT(*) FROM room_members WHERE room_id = $1",
        [roomId]
      );
      expect(parseInt(beforeCount.rows[0].count)).toBe(1);

      // Delete the room
      await testPool.query("DELETE FROM chat_rooms WHERE room_id = $1", [roomId]);

      // Member should be cascade deleted
      const afterCount = await testPool.query(
        "SELECT COUNT(*) FROM room_members WHERE room_id = $1",
        [roomId]
      );
      expect(parseInt(afterCount.rows[0].count)).toBe(0);
    });

    it('should delete room memberships when a user is deleted (ON DELETE CASCADE)', async () => {
      // Confirm member exists
      const beforeCount = await testPool.query(
        "SELECT COUNT(*) FROM room_members WHERE user_id = $1",
        [userId]
      );
      expect(parseInt(beforeCount.rows[0].count)).toBe(1);

      // Delete the user
      await testPool.query("DELETE FROM users WHERE user_id = $1", [userId]);

      // Member should be cascade deleted
      const afterCount = await testPool.query(
        "SELECT COUNT(*) FROM room_members WHERE user_id = $1",
        [userId]
      );
      expect(parseInt(afterCount.rows[0].count)).toBe(0);
    });

    it('should preserve message but set sender_id to NULL when a user is deleted (ON DELETE SET NULL)', async () => {
      // Insert message
      const msgRes = await testPool.query(
        "INSERT INTO messages (room_id, sender_id, content) VALUES ($1, $2, 'Hello world') RETURNING message_id",
        [roomId, userId]
      );
      const messageId = msgRes.rows[0].message_id;

      // Delete user
      await testPool.query("DELETE FROM users WHERE user_id = $1", [userId]);

      // Message should remain but sender_id should be NULL
      const msgAfter = await testPool.query(
        "SELECT sender_id, content FROM messages WHERE message_id = $1",
        [messageId]
      );
      expect(msgAfter.rows[0].sender_id).toBeNull();
      expect(msgAfter.rows[0].content).toBe('Hello world');
    });

    it('should cascade delete messages when a chat room is deleted (ON DELETE CASCADE)', async () => {
      // Insert message
      await testPool.query(
        "INSERT INTO messages (room_id, sender_id, content) VALUES ($1, $2, 'Hello world')",
        [roomId, userId]
      );

      // Delete room
      await testPool.query("DELETE FROM chat_rooms WHERE room_id = $1", [roomId]);

      // Messages should be cascade deleted
      const msgCount = await testPool.query(
        "SELECT COUNT(*) FROM messages WHERE room_id = $1",
        [roomId]
      );
      expect(parseInt(msgCount.rows[0].count)).toBe(0);
    });
  });
});
