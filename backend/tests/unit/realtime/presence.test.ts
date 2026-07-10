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


import { trackUserConnection, trackUserDisconnection, isUserOnline, getOnlineUsers, clearPresence } from '../../../src/realtime/presence';
import type { ChatServer } from '../../../src/realtime/authSocket';

describe('presence tracker', () => {
  let io: any;
  let roomEmit: any;
  let friendRepo: any;

  beforeEach(() => {
    clearPresence();
    roomEmit = vi.fn();
    io = {
      to: vi.fn(() => ({ emit: roomEmit })),
    } as unknown as ChatServer;

    friendRepo = {
      getFriends: vi.fn().mockResolvedValue([
        { friend: { userId: 'friend-1' } },
        { friend: { userId: 'friend-2' } }
      ])
    };
  });

  it('tracks connection, reports online status, and notifies online friends', async () => {
    // Initially offline
    expect(isUserOnline('user-1')).toBe(false);

    // Friend-1 is online (has socket registered)
    await trackUserConnection(io, 'friend-1', 'socket-friend', friendRepo);
    expect(isUserOnline('friend-1')).toBe(true);

    // User-1 connects
    await trackUserConnection(io, 'user-1', 'socket-1', friendRepo);
    expect(isUserOnline('user-1')).toBe(true);
    expect(getOnlineUsers()).toContain('user-1');

    // Should broadcast status 'online' to friend-1's room, but not friend-2 (since friend-2 is offline)
    expect(io.to).toHaveBeenCalledWith('user_friend-1');
    expect(io.to).not.toHaveBeenCalledWith('user_friend-2');
    expect(roomEmit).toHaveBeenCalledWith('user_status', { userId: 'user-1', status: 'online' });
  });

  it('handles trackUserDisconnection gracefully when userId was never tracked', async () => {
    await expect(
      trackUserDisconnection(io, 'unknown-user', 'socket-1', friendRepo)
    ).resolves.toBeUndefined();
  });

  it('suppresses and logs errors from getFriends during trackUserConnection', async () => {
    const errorRepo = { getFriends: vi.fn().mockRejectedValue(new Error('DB down')) };
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(trackUserConnection(io, 'user-x', 'socket-1', errorRepo)).resolves.toBeUndefined();

    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
    clearPresence();
  });

  it('suppresses and logs errors from getFriends during trackUserDisconnection', async () => {
    await trackUserConnection(io, 'user-y', 'socket-1', friendRepo);

    const errorRepo = { getFriends: vi.fn().mockRejectedValue(new Error('DB down')) };
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(trackUserDisconnection(io, 'user-y', 'socket-1', errorRepo)).resolves.toBeUndefined();

    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('handles multiple socket connections per user and tracks disconnection', async () => {
    // User connects on tab 1
    await trackUserConnection(io, 'user-1', 'socket-tab-1', friendRepo);
    // User connects on tab 2
    await trackUserConnection(io, 'user-1', 'socket-tab-2', friendRepo);

    expect(isUserOnline('user-1')).toBe(true);

    // Disconnect tab 1
    await trackUserDisconnection(io, 'user-1', 'socket-tab-1', friendRepo);
    // User is still online because tab 2 is open
    expect(isUserOnline('user-1')).toBe(true);
    expect(roomEmit).not.toHaveBeenCalledWith('user_status', { userId: 'user-1', status: 'offline' });

    // Friend-1 is online
    await trackUserConnection(io, 'friend-1', 'socket-friend', friendRepo);
    roomEmit.mockClear();

    // Disconnect tab 2
    await trackUserDisconnection(io, 'user-1', 'socket-tab-2', friendRepo);
    // User is now offline
    expect(isUserOnline('user-1')).toBe(false);
    // Should broadcast offline status to friend-1
    expect(io.to).toHaveBeenCalledWith('user_friend-1');
    expect(roomEmit).toHaveBeenCalledWith('user_status', { userId: 'user-1', status: 'offline' });
  });
});
