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


import { makeFriendService } from '../../../src/services/friendService';
import { AppError } from '../../../src/errors/AppError';

describe('friendService', () => {
  it('respondFriendRequest throws NOT_FOUND when accepting non-existent request', async () => {
    const mockRepo = {
      isBlocked: vi.fn().mockResolvedValue(false),
      acceptFriendRequest: vi.fn().mockResolvedValue(null)
    } as any;
    const service = makeFriendService(mockRepo);
    await expect(service.respondFriendRequest('u1', 'u2', 'accepted')).rejects.toThrow(AppError);
  });

  it('respondFriendRequest throws NOT_FOUND when rejecting non-existent request', async () => {
    const mockRepo = {
      rejectFriendRequest: vi.fn().mockResolvedValue(null)
    } as any;
    const service = makeFriendService(mockRepo);
    await expect(service.respondFriendRequest('u1', 'u2', 'rejected')).rejects.toThrow(AppError);
  });

  it('unblockUser calls repo.unblockUser', async () => {
    const mockRepo = {
      unblockUser: vi.fn().mockResolvedValue(true),
      areFriends: vi.fn().mockResolvedValue(false),
    } as any;
    const service = makeFriendService(mockRepo);
    const result = await service.unblockUser('u1', 'u2');
    expect(mockRepo.unblockUser).toHaveBeenCalledWith('u1', 'u2');
    expect(mockRepo.areFriends).toHaveBeenCalledWith('u1', 'u2');
    expect(result).toBeUndefined();
  });

  it('unblockUser reopens the private room when the users are still friends', async () => {
    const mockRepo = {
      unblockUser: vi.fn().mockResolvedValue(true),
      areFriends: vi.fn().mockResolvedValue(true),
    } as any;
    const privateRooms = { markPrivateReadOnly: vi.fn(), reopenPrivateRoom: vi.fn() };
    const service = makeFriendService(mockRepo, undefined, privateRooms as any);
    await service.unblockUser('u1', 'u2');
    expect(privateRooms.reopenPrivateRoom).toHaveBeenCalledWith('u1', 'u2');
  });

  it('sendFriendRequest throws when sending to yourself', async () => {
    const service = makeFriendService({} as any);
    await expect(service.sendFriendRequest('u1', 'u1')).rejects.toThrow('Cannot send friend request to yourself');
  });

  it('sendFriendRequest throws FORBIDDEN when blocked', async () => {
    const mockRepo = {
      isBlocked: vi.fn().mockResolvedValue(true)
    } as any;
    const service = makeFriendService(mockRepo);
    await expect(service.sendFriendRequest('u1', 'u2')).rejects.toThrow('Cannot interact with this user');
  });

  it('sendFriendRequest throws when already friends', async () => {
    const mockRepo = {
      isBlocked: vi.fn().mockResolvedValue(false),
      areFriends: vi.fn().mockResolvedValue(true)
    } as any;
    const service = makeFriendService(mockRepo);
    await expect(service.sendFriendRequest('u1', 'u2')).rejects.toThrow('Already friends');
  });

  it('sendFriendRequest creates a request and notifies the target', async () => {
    const request = { requesterId: 'u1', targetUserId: 'u2', status: 'pending' };
    const mockRepo = {
      isBlocked: vi.fn().mockResolvedValue(false),
      areFriends: vi.fn().mockResolvedValue(false),
      getPendingRequests: vi.fn().mockResolvedValue([]),
      sendFriendRequest: vi.fn().mockResolvedValue(request)
    } as any;
    const notifyUser = vi.fn();
    const service = makeFriendService(mockRepo, notifyUser);
    const result = await service.sendFriendRequest('u1', 'u2');
    expect(result).toEqual(request);
    expect(notifyUser).toHaveBeenCalledWith('u2', 'friend_request', request);
  });

  it('sendFriendRequest auto-accepts a reciprocal pending request and reopens private room if exists', async () => {
    const accepted = { requesterId: 'u2', targetUserId: 'u1', status: 'accepted' };
    const mockRepo = {
      isBlocked: vi.fn().mockResolvedValue(false),
      areFriends: vi.fn().mockResolvedValue(false),
      getPendingRequests: vi.fn().mockResolvedValue([{ requesterId: 'u2' }]),
      acceptFriendRequest: vi.fn().mockResolvedValue(accepted)
    } as any;
    const notifyUser = vi.fn();
    const privateRooms = { markPrivateReadOnly: vi.fn(), reopenPrivateRoom: vi.fn() };
    const service = makeFriendService(mockRepo, notifyUser, privateRooms as any);
    const result = await service.sendFriendRequest('u1', 'u2');
    expect(result).toEqual(accepted);
    expect(mockRepo.acceptFriendRequest).toHaveBeenCalledWith('u2', 'u1');
    expect(privateRooms.reopenPrivateRoom).toHaveBeenCalledWith('u1', 'u2');
    expect(notifyUser).toHaveBeenCalledWith('u2', 'friend_request', accepted);
  });

  it('respondFriendRequest accepted reopens private room if exists', async () => {
    const accepted = { requesterId: 'u2', targetUserId: 'u1', status: 'accepted' };
    const mockRepo = {
      isBlocked: vi.fn().mockResolvedValue(false),
      acceptFriendRequest: vi.fn().mockResolvedValue(accepted)
    } as any;
    const privateRooms = { markPrivateReadOnly: vi.fn(), reopenPrivateRoom: vi.fn() };
    const service = makeFriendService(mockRepo, undefined, privateRooms as any);
    const result = await service.respondFriendRequest('u1', 'u2', 'accepted');
    expect(result).toEqual(accepted);
    expect(privateRooms.reopenPrivateRoom).toHaveBeenCalledWith('u2', 'u1');
  });

  it('respondFriendRequest accepted throws FORBIDDEN when blocked', async () => {
    const mockRepo = {
      isBlocked: vi.fn().mockResolvedValue(true)
    } as any;
    const service = makeFriendService(mockRepo);
    await expect(service.respondFriendRequest('u1', 'u2', 'accepted')).rejects.toThrow('Cannot interact with this user');
  });

  it('respondFriendRequest rejected returns rejected status', async () => {
    const mockRepo = {
      rejectFriendRequest: vi.fn().mockResolvedValue({ status: 'rejected' })
    } as any;
    const service = makeFriendService(mockRepo);
    const result = await service.respondFriendRequest('u1', 'u2', 'rejected');
    expect(result).toEqual({ status: 'rejected' });
  });

  it('removeFriend deletes the friendship and marks the private room read-only', async () => {
    const mockRepo = {
      deleteFriendship: vi.fn().mockResolvedValue(undefined)
    } as any;
    const privateRooms = { markPrivateReadOnly: vi.fn() };
    const service = makeFriendService(mockRepo, undefined, privateRooms as any);
    await service.removeFriend('u1', 'u2');
    expect(mockRepo.deleteFriendship).toHaveBeenCalledWith('u1', 'u2');
    expect(privateRooms.markPrivateReadOnly).toHaveBeenCalledWith('u1', 'u2');
  });

  it('blockUser throws when blocking yourself', async () => {
    const service = makeFriendService({} as any);
    await expect(service.blockUser('u1', 'u1')).rejects.toThrow('Cannot block yourself');
  });

  it('blockUser blocks and marks the room read-only without deleting the friendship', async () => {
    const mockRepo = {
      blockUser: vi.fn().mockResolvedValue(undefined),
    } as any;
    const privateRooms = { markPrivateReadOnly: vi.fn() };
    const service = makeFriendService(mockRepo, undefined, privateRooms as any);
    const result = await service.blockUser('u1', 'u2');
    expect(result).toEqual({ status: 'blocked' });
    expect(mockRepo.blockUser).toHaveBeenCalledWith('u1', 'u2');
    expect(privateRooms.markPrivateReadOnly).toHaveBeenCalledWith('u1', 'u2');
  });

  it('getPendingRequests, getFriends and getBlockedUsers delegate to the repo', async () => {
    const mockRepo = {
      getPendingRequests: vi.fn().mockResolvedValue(['p']),
      getFriends: vi.fn().mockResolvedValue(['f']),
      getBlockedUsers: vi.fn().mockResolvedValue(['b'])
    } as any;
    const service = makeFriendService(mockRepo);
    expect(await service.getPendingRequests('u1')).toEqual(['p']);
    expect(await service.getFriends('u1')).toEqual(['f']);
    expect(await service.getBlockedUsers('u1')).toEqual(['b']);
  });
});
