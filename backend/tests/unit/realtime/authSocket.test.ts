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


import { signToken } from '../../../src/auth/jwt';
import { attachSocketAuth, type ChatServer } from '../../../src/realtime/authSocket';

vi.mock('../../../src/db', () => ({
  default: { query: vi.fn().mockResolvedValue({ rows: [{}] }) },
}));

describe('attachSocketAuth', () => {
  it('rejects connections without a token', () => {
    let middleware: any;
    const io = { use: vi.fn((fn) => { middleware = fn; }) } as unknown as ChatServer;
    attachSocketAuth(io);

    const next = vi.fn();
    middleware({ handshake: { auth: {} } }, next);

    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });

  it('rejects connections with an empty string token', () => {
    let middleware: any;
    const io = { use: vi.fn((fn) => { middleware = fn; }) } as unknown as ChatServer;
    attachSocketAuth(io);
    const next = vi.fn();
    middleware({ handshake: { auth: { token: '' } } }, next);
    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });

  it('rejects when user is not found in the database', async () => {
    const { default: pool } = await import('../../../src/db');
    vi.mocked(pool.query).mockResolvedValueOnce({ rows: [] } as any);
    let middleware: any;
    const io = { use: vi.fn((fn) => { middleware = fn; }) } as unknown as ChatServer;
    attachSocketAuth(io);
    const socket = { handshake: { auth: { token: signToken({ userId: 'ghost', name: 'Ghost' }) } }, data: {} };
    const next = vi.fn();
    await middleware(socket, next);
    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });

  it('rejects when verifyToken throws due to a malformed token', async () => {
    let middleware: any;
    const io = { use: vi.fn((fn) => { middleware = fn; }) } as unknown as ChatServer;
    attachSocketAuth(io);
    const next = vi.fn();
    await middleware({ handshake: { auth: { token: 'not.a.valid.token' } } }, next);
    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });

  it('verifies tokens with the shared JWT helper and stores socket data user', async () => {
    let middleware: any;
    const io = { use: vi.fn((fn) => { middleware = fn; }) } as unknown as ChatServer;
    const socket = {
      handshake: { auth: { token: signToken({ userId: 'user-1', name: 'Alice' }) } },
      data: {},
    };
    attachSocketAuth(io);

    const next = vi.fn();
    await middleware(socket, next);

    expect(next).toHaveBeenCalledWith();
    expect(socket.data).toMatchObject({
      user: { userId: 'user-1', name: 'Alice' },
    });
  });
});
