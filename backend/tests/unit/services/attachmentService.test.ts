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


import { makeAttachmentService } from '../../../src/services/attachmentService';

describe('AttachmentService', () => {
  let attachmentRepo: { create: ReturnType<typeof vi.fn>; findById: ReturnType<typeof vi.fn> };
  let service: ReturnType<typeof makeAttachmentService>;

  beforeEach(() => {
    attachmentRepo = {
      create: vi.fn(),
      findById: vi.fn(),
    };
    service = makeAttachmentService(attachmentRepo as any);
  });

  it('normalizes mojibake original filenames before persisting', async () => {
    attachmentRepo.create.mockResolvedValue({
      attachment_id: 'att-1',
      uploaded_by: 'user-1',
      file_type: 'application/pdf',
      original_name: '運算思維與程式設計平台 多個頁點.pdf',
      uploaded_at: new Date('2026-01-01T00:00:00.000Z'),
    });

    await service.uploadAttachment('user-1', {
      path: '/tmp/file.pdf',
      mimetype: 'application/pdf',
      originalname: 'éç®æç¶­èç¨å¼è¨­è¨å¹³å° å¤åé é».pdf',
    } as Express.Multer.File);

    expect(attachmentRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        originalName: '運算思維與程式設計平台 多個頁點.pdf',
      }),
    );
  });

  it('getAttachment returns null when the parent message has been recalled', async () => {
    attachmentRepo.findById.mockResolvedValue({
      attachment_id: 'att-1',
      message_id: 'msg-1',
      message_is_recalled: true,
    });

    await expect(service.getAttachment('att-1')).resolves.toBeNull();
  });

  it('getAttachment returns the attachment when the parent message has not been recalled', async () => {
    const attachment = {
      attachment_id: 'att-1',
      message_id: 'msg-1',
      message_is_recalled: false,
    };
    attachmentRepo.findById.mockResolvedValue(attachment);

    await expect(service.getAttachment('att-1')).resolves.toEqual(attachment);
  });

  it('getAttachment returns the attachment when it is not yet linked to any message', async () => {
    const attachment = {
      attachment_id: 'att-1',
      message_id: null,
      message_is_recalled: null,
    };
    attachmentRepo.findById.mockResolvedValue(attachment);

    await expect(service.getAttachment('att-1')).resolves.toEqual(attachment);
  });

  it('getAttachment returns null when the attachment does not exist', async () => {
    attachmentRepo.findById.mockResolvedValue(null);

    await expect(service.getAttachment('missing')).resolves.toBeNull();
  });
});
