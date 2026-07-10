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


import { startInactivityJob } from '../../../src/cron/inactivityJob';
import type { IUserRepository } from '../../../src/repositories/IUserRepository';

describe('inactivityJob', () => {
  let mockUserRepo: import('vitest').Mocked<IUserRepository>;
  let mockUserService: any;

  beforeEach(() => {
    vi.useFakeTimers();
    mockUserRepo = {
      findById: vi.fn(),
      findByEmail: vi.fn(),
      search: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      findAllWarningEnabled: vi.fn(),
    };
    mockUserService = {
      checkInactivity: vi.fn(),
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should call checkInactivity for each user and prevent overlapping runs', async () => {
    const mockUsers = [
      { userId: 'u1' },
      { userId: 'u2' }
    ];
    mockUserRepo.findAllWarningEnabled.mockResolvedValue(mockUsers as any);
    
    // Simulate a slow checkInactivity to test lock
    let checkPromiseResolve: () => void;
    mockUserService.checkInactivity.mockImplementation(() => {
      return new Promise<void>((resolve) => {
        checkPromiseResolve = resolve;
      });
    });

    const intervalId = startInactivityJob(mockUserRepo, mockUserService, 1000);
    
    // Fast forward to first execution
    vi.advanceTimersByTime(1000);
    
    // Allow the promise chain to settle so that the first interval execution reaches findAllWarningEnabled
    await Promise.resolve();
    
    expect(mockUserRepo.findAllWarningEnabled).toHaveBeenCalledTimes(1);
    
    // Fast forward to second execution before the first one finishes
    vi.advanceTimersByTime(1000);
    await Promise.resolve();
    
    // It should not call findAllWarningEnabled again because the lock is held
    expect(mockUserRepo.findAllWarningEnabled).toHaveBeenCalledTimes(1);

    clearInterval(intervalId);
  });

  it('continues with remaining users when checkInactivity fails for one user', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockUserRepo.findAllWarningEnabled.mockResolvedValue([
      { userId: 'u1' },
      { userId: 'u2' }
    ] as any);
    mockUserService.checkInactivity
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(undefined);

    const intervalId = startInactivityJob(mockUserRepo, mockUserService, 1000);
    await vi.advanceTimersByTimeAsync(1000);

    expect(mockUserService.checkInactivity).toHaveBeenCalledTimes(2);
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Error checking inactivity for user u1'),
      expect.any(Error)
    );

    clearInterval(intervalId);
    consoleSpy.mockRestore();
  });

  it('logs and releases the lock when findAllWarningEnabled fails', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockUserRepo.findAllWarningEnabled
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValueOnce([] as any);

    const intervalId = startInactivityJob(mockUserRepo, mockUserService, 1000);
    await vi.advanceTimersByTimeAsync(1000);

    expect(consoleSpy).toHaveBeenCalledWith('Error running inactivity job:', expect.any(Error));

    // The lock must be released so the next tick runs again
    await vi.advanceTimersByTimeAsync(1000);
    expect(mockUserRepo.findAllWarningEnabled).toHaveBeenCalledTimes(2);

    clearInterval(intervalId);
    consoleSpy.mockRestore();
  });
});
