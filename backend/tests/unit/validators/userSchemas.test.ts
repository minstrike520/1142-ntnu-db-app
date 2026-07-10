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


import {
  loginSchema,
  registerSchema,
  searchQuerySchema,
  updateMeSchema,
  updateSettingsSchema,
} from '../../../src/validators/userSchemas';

describe('user validation schemas', () => {
  it('validates register payloads and enforces password length', () => {
    expect(registerSchema.safeParse({
      email: 'user@example.com',
      name: 'Alice',
      password: 'password123',
    }).success).toBe(true);
    expect(registerSchema.safeParse({
      email: 'invalid',
      name: 'Alice',
      password: 'password123',
    }).success).toBe(false);
    expect(registerSchema.safeParse({
      email: 'user@example.com',
      name: '',
      password: 'password123',
    }).success).toBe(false);
    expect(registerSchema.safeParse({
      email: 'user@example.com',
      name: 'Alice',
      password: 'short',
    }).success).toBe(false);
  });

  it('validates login payloads', () => {
    expect(loginSchema.safeParse({
      email: 'user@example.com',
      password: 'password123',
    }).success).toBe(true);
    expect(loginSchema.safeParse({
      email: 'user@example.com',
      password: '',
    }).success).toBe(false);
  });

  it('requires at least one valid profile update field', () => {
    expect(updateMeSchema.parse({ name: '  Alice  ' })).toEqual({ name: 'Alice' });
    expect(updateMeSchema.safeParse({}).success).toBe(false);
    expect(updateMeSchema.safeParse({ name: '   ' }).success).toBe(false);
    expect(updateMeSchema.safeParse({ avatarUrl: 'not-a-url' }).success).toBe(false);
    expect(updateMeSchema.safeParse({ warningDays: 0 }).success).toBe(false);
  });

  it('validates bio constraints in updateMeSchema', () => {
    expect(updateMeSchema.safeParse({ bio: 'Hello world' }).success).toBe(true);
    expect(updateMeSchema.safeParse({ bio: '' }).success).toBe(true);
    expect(updateMeSchema.safeParse({ bio: '1\n2\n3\n4\n5\n6\n7\n8' }).success).toBe(true);
    expect(updateMeSchema.safeParse({ bio: '1\n2\n3\n4\n5\n6\n7\n8\n9' }).success).toBe(false);
    expect(updateMeSchema.safeParse({ bio: 'a'.repeat(101) }).success).toBe(false);
    expect(updateMeSchema.safeParse({ bio: 'a'.repeat(100) }).success).toBe(true);
  });

  it('requires at least one valid settings field', () => {
    expect(updateSettingsSchema.parse({ warningDays: 0 })).toEqual({ warningDays: 0 });
    expect(updateSettingsSchema.parse({ language: ' zh-TW ' })).toEqual({ language: 'zh-TW' });
    expect(updateSettingsSchema.safeParse({}).success).toBe(false);
    expect(updateSettingsSchema.safeParse({ warningDays: -1 }).success).toBe(false);
    expect(updateSettingsSchema.safeParse({ language: 'bad_tag!' }).success).toBe(false);
  });

  it('validates trimmed search queries', () => {
    expect(searchQuerySchema.parse({ q: ' Alice ' })).toEqual({ q: 'Alice' });
    expect(searchQuerySchema.safeParse({ q: '   ' }).success).toBe(false);
  });
});
