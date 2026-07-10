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


import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { ValidationError } from '../../../src/errors/AppError';
import { assertValidAvatarUpload, removeManagedAvatar } from '../../../src/lib/avatarUpload';
import { AVATARS_UPLOAD_DIR, ensureUploadDirectories } from '../../../src/lib/uploads';

const makeFile = (mimetype: string, bytes: number[]): Express.Multer.File =>
  ({
    fieldname: 'file',
    originalname: 'avatar',
    encoding: '7bit',
    mimetype,
    size: bytes.length,
    buffer: Buffer.from(bytes),
  }) as Express.Multer.File;

describe('avatarUpload helpers', () => {
  it('accepts matching png content', () => {
    const extension = assertValidAvatarUpload(
      makeFile('image/png', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );

    expect(extension).toBe('.png');
  });

  it('rejects unsupported mimetypes', () => {
    expect(() =>
      assertValidAvatarUpload(makeFile('image/svg+xml', [0x3c, 0x73, 0x76, 0x67])),
    ).toThrow(ValidationError);
  });

  it('rejects mismatched content signatures', () => {
    expect(() =>
      assertValidAvatarUpload(makeFile('image/png', [0xff, 0xd8, 0xff, 0xe0])),
    ).toThrow(ValidationError);
  });
});

describe('removeManagedAvatar', () => {
  const createdFiles: string[] = [];

  const makeManagedFile = async (ownerId: string): Promise<string> => {
    ensureUploadDirectories();
    const fileName = `${ownerId}-${crypto.randomUUID()}.png`;
    const fullPath = path.join(AVATARS_UPLOAD_DIR, fileName);
    await fs.writeFile(fullPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    createdFiles.push(fullPath);
    return `/uploads/avatars/${fileName}`;
  };

  afterEach(async () => {
    while (createdFiles.length > 0) {
      const file = createdFiles.pop()!;
      await fs.rm(file, { force: true });
    }
  });

  it('deletes a managed avatar that belongs to the owner', async () => {
    const ownerId = 'user-owns-this';
    const avatarUrl = await makeManagedFile(ownerId);
    const fullPath = path.join(AVATARS_UPLOAD_DIR, path.basename(avatarUrl));

    await removeManagedAvatar(avatarUrl, ownerId);

    await expect(fs.access(fullPath)).rejects.toThrow();
  });

  it('refuses to delete a file whose prefix does not match the owner', async () => {
    const victimId = 'victim-user';
    const attackerId = 'attacker-user';
    const victimUrl = await makeManagedFile(victimId);
    const fullPath = path.join(AVATARS_UPLOAD_DIR, path.basename(victimUrl));

    // Attacker attempts to delete the victim's file by passing the victim URL.
    await removeManagedAvatar(victimUrl, attackerId);

    // Victim's file must still exist.
    await fs.access(fullPath);
  });

  it('ignores non-managed urls', async () => {
    await expect(
      removeManagedAvatar('http://evil.example/uploads/avatars/x.png', 'anyone'),
    ).resolves.toBeUndefined();
    await expect(removeManagedAvatar('', 'anyone')).resolves.toBeUndefined();
    await expect(removeManagedAvatar(undefined, 'anyone')).resolves.toBeUndefined();
  });
});
