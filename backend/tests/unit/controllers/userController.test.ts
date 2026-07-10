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

import type { NextFunction, Request, Response } from 'express';

import { makeUserController } from '../../../src/controllers/userController';
import { ValidationError } from '../../../src/errors/AppError';

const mockRes = () => {
  const res = { status: vi.fn(), json: vi.fn(), send: vi.fn() } as any;
  res.status.mockReturnValue(res);
  return res;
};

const authedReq = (overrides: Partial<Request> = {}): any => ({
  body: {},
  params: {},
  query: {},
  user: { userId: 'user-1' },
  ...overrides,
});

describe('userController', () => {
  const myProfile = {
    userId: 'user-1',
    name: 'Alice',
    email: 'alice@example.com',
    bio: 'Hello',
    avatarUrl: 'https://example.com/avatar.png',
  };
  const publicProfile = {
    userId: 'user-2',
    name: 'Bob',
    bio: 'Public bio',
    avatarUrl: 'https://example.com/bob.png',
  };
  const settings = {
    warningEnabled: true,
    warningDays: 3,
    language: 'zh-TW',
    theme: 'dark',
    notifyDesktop: false,
    notifySound: false,
  };
  const service = {
    getMe: vi.fn(),
    getUserProfile: vi.fn(),
    updateMe: vi.fn(),
    uploadAvatar: vi.fn(),
    getMySettings: vi.fn(),
    updateMySettings: vi.fn(),
    deleteMe: vi.fn(),
    search: vi.fn(),
    getEmergencyContacts: vi.fn(),
    upsertEmergencyContact: vi.fn(),
    deleteEmergencyContact: vi.fn(),
    checkInactivity: vi.fn(),
  } as any;
  const ctrl = makeUserController(service);

  beforeEach(() => vi.clearAllMocks());

  it('returns my profile for getMe', async () => {
    service.getMe.mockResolvedValue(myProfile);
    const res = mockRes();
    const next = vi.fn();

    await ctrl.getMe(authedReq(), res, next);

    expect(service.getMe).toHaveBeenCalledWith('user-1');
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(myProfile);
  });

  it('returns another user profile for getUserProfile', async () => {
    service.getUserProfile.mockResolvedValue(publicProfile);
    const res = mockRes();
    const next = vi.fn();

    await ctrl.getUserProfile(authedReq({ params: { id: 'user-2' } }), res, next);

    expect(service.getUserProfile).toHaveBeenCalledWith('user-2');
    expect(res.json).toHaveBeenCalledWith(publicProfile);
  });

  it('updates the editable profile fields', async () => {
    const updated = { ...myProfile, name: 'Alice 2' };
    service.updateMe.mockResolvedValue(updated);
    const res = mockRes();
    const next = vi.fn();

    await ctrl.updateMe(authedReq({ body: { name: 'Alice 2' } }), res, next);

    expect(service.updateMe).toHaveBeenCalledWith('user-1', { name: 'Alice 2' });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(updated);
  });

  it('rejects empty profile payloads', async () => {
    const res = mockRes();
    const next = vi.fn();

    await ctrl.updateMe(authedReq({ body: {} }), res, next);

    expect(next).toHaveBeenCalledWith(expect.any(ValidationError));
  });

  it('uploads avatar for the current user', async () => {
    const updated = { ...myProfile, avatarUrl: '/uploads/avatars/user-1.png' };
    service.uploadAvatar.mockResolvedValue(updated);
    const res = mockRes();
    const next = vi.fn();
    const file = {
      fieldname: 'file',
      originalname: 'avatar.png',
      encoding: '7bit',
      mimetype: 'image/png',
      size: 16,
      buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    } as Express.Multer.File;

    await ctrl.uploadAvatar(authedReq({ file }), res, next);

    expect(service.uploadAvatar).toHaveBeenCalledWith('user-1', file);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(updated);
  });

  it('rejects avatar uploads without a file', async () => {
    const res = mockRes();
    const next = vi.fn();

    await ctrl.uploadAvatar(authedReq(), res, next);

    expect(next).toHaveBeenCalledWith(expect.any(ValidationError));
  });

  it('returns my settings', async () => {
    service.getMySettings.mockResolvedValue(settings);
    const res = mockRes();
    const next = vi.fn();

    await ctrl.getMySettings(authedReq(), res, next);

    expect(service.getMySettings).toHaveBeenCalledWith('user-1');
    expect(res.json).toHaveBeenCalledWith(settings);
  });

  it('updates my settings', async () => {
    service.updateMySettings.mockResolvedValue(settings);
    const res = mockRes();
    const next = vi.fn();

    await ctrl.updateMySettings(
      authedReq({
        body: {
          warningEnabled: true,
          warningDays: 3,
          language: 'zh-TW',
          theme: 'dark',
          notifyDesktop: false,
          notifySound: false,
        },
      }),
      res,
      next,
    );

    expect(service.updateMySettings).toHaveBeenCalledWith('user-1', settings);
    expect(res.json).toHaveBeenCalledWith(settings);
  });

  it('rejects invalid settings payloads', async () => {
    const res = mockRes();
    const next = vi.fn();

    await ctrl.updateMySettings(authedReq({ body: { warningDays: -1 } }), res, next);

    expect(next).toHaveBeenCalledWith(expect.any(ValidationError));
  });

  it('searches users', async () => {
    service.search.mockResolvedValue([{ userId: 'user-2', name: 'Bob', email: 'bob@example.com', avatarUrl: undefined }]);
    const res = mockRes();
    const next = vi.fn();

    await ctrl.search(authedReq({ query: { q: 'bob' } }), res, next);

    expect(service.search).toHaveBeenCalledWith('bob', undefined);
    expect(res.json).toHaveBeenCalledWith([{ userId: 'user-2', name: 'Bob', email: 'bob@example.com', avatarUrl: undefined }]);
  });

  it('searches users with mode', async () => {
    service.search.mockResolvedValue([{ userId: 'user-2', name: 'Bob', email: 'bob@example.com', avatarUrl: undefined }]);
    const res = mockRes();
    const next = vi.fn();

    await ctrl.search(authedReq({ query: { q: 'bob', mode: 'email' } }), res, next);

    expect(service.search).toHaveBeenCalledWith('bob', 'email');
    expect(res.json).toHaveBeenCalledWith([{ userId: 'user-2', name: 'Bob', email: 'bob@example.com', avatarUrl: undefined }]);
  });

  it('rejects invalid mode value', async () => {
    const res = mockRes();
    const next = vi.fn();

    await ctrl.search(authedReq({ query: { q: 'bob', mode: 'invalid' } }), res, next);

    expect(next).toHaveBeenCalledWith(expect.any(ValidationError));
    expect(service.search).not.toHaveBeenCalled();
  });

  it('soft deletes the current user', async () => {
    const res = mockRes();
    const next = vi.fn();

    await ctrl.deleteMe(authedReq(), res, next);

    expect(service.deleteMe).toHaveBeenCalledWith('user-1');
    expect(res.status).toHaveBeenCalledWith(204);
  });

  it('returns emergency contacts', async () => {
    service.getEmergencyContacts.mockResolvedValue([{ id: 'c1' }]);
    const res = mockRes();
    const next = vi.fn();

    await ctrl.getEmergencyContacts(authedReq(), res, next);

    expect(res.json).toHaveBeenCalledWith([{ id: 'c1' }]);
  });

  it('upserts emergency contacts', async () => {
    const contact = { contactId: '550e8400-e29b-41d4-a716-446655440000', message: 'msg' };
    service.upsertEmergencyContact.mockResolvedValue({ contact, isUpdate: false });
    const res = mockRes();
    const next = vi.fn();

    await ctrl.addEmergencyContact(
      authedReq({ body: { contactId: contact.contactId, message: 'msg' } }),
      res,
      next,
    );

    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(contact);
  });

  it('deletes emergency contacts', async () => {
    const res = mockRes();
    const next = vi.fn();

    await ctrl.deleteEmergencyContact(authedReq({ params: { contactId: 'c1' } }), res, next);

    expect(service.deleteEmergencyContact).toHaveBeenCalledWith('user-1', 'c1');
    expect(res.json).toHaveBeenCalledWith({ success: true });
  });



  it('checks inactivity alerts', async () => {
    service.checkInactivity.mockResolvedValue({ alerted: true });
    const res = mockRes();
    const next = vi.fn();

    await ctrl.checkEmergencyInactivity(
      authedReq({ body: { now: new Date().toISOString() } }),
      res,
      next,
    );

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ alerted: true });
  });

  it('passes through service errors', async () => {
    const err = new Error('db error');
    service.getMe.mockRejectedValue(err);
    const res = mockRes();
    const next: NextFunction = vi.fn();

    await ctrl.getMe(authedReq(), res as Response, next);

    expect(next).toHaveBeenCalledWith(err);
  });

  const errorMethods: Array<[string, any, any]> = [
    ['updateMe', (c: any) => c.updateMe, authedReq({ body: { name: 'A' } })],
    ['uploadAvatar', (c: any) => c.uploadAvatar, authedReq({ file: { originalname: 'a.png' } as any })],
    ['getUserProfile', (c: any) => c.getUserProfile, authedReq({ params: { id: 'u2' } })],
    ['getMySettings', (c: any) => c.getMySettings, authedReq()],
    ['updateMySettings', (c: any) => c.updateMySettings, authedReq({ body: { warningEnabled: true, warningDays: 1 } })],
    ['deleteMe', (c: any) => c.deleteMe, authedReq()],
    ['getEmergencyContacts', (c: any) => c.getEmergencyContacts, authedReq()],
    ['checkEmergencyInactivity', (c: any) => c.checkEmergencyInactivity, authedReq()],
    ['search', (c: any) => c.search, authedReq({ query: { q: 'alice' } })],
  ];

  for (const [name, getMethod, req] of errorMethods) {
    it(`passes service errors from ${name} to next`, async () => {
      const err = new Error(`${name} failed`);
      const key = name === 'getUserProfile' ? 'getUserProfile'
        : name === 'getMySettings' ? 'getMySettings'
        : name === 'updateMySettings' ? 'updateMySettings'
        : name === 'deleteMe' ? 'deleteMe'
        : name === 'getEmergencyContacts' ? 'getEmergencyContacts'
        : name === 'checkEmergencyInactivity' ? 'checkInactivity'
        : name === 'search' ? 'search'
        : name === 'uploadAvatar' ? 'uploadAvatar'
        : 'updateMe';
      (service as any)[key].mockRejectedValue(err);
      const res = mockRes();
      const next = vi.fn();
      await getMethod(ctrl)(req, res, next);
      expect(next).toHaveBeenCalledWith(err);
    });
  }

  it('passes service errors from addEmergencyContact to next', async () => {
    const err = new Error('upsert failed');
    service.upsertEmergencyContact.mockRejectedValue(err);
    const res = mockRes();
    const next = vi.fn();
    await ctrl.addEmergencyContact(authedReq({ body: { contactId: '550e8400-e29b-41d4-a716-446655440000', message: 'help' } }), res, next);
    expect(next).toHaveBeenCalledWith(err);
  });

  it('passes service errors from deleteEmergencyContact to next', async () => {
    const err = new Error('delete failed');
    service.deleteEmergencyContact.mockRejectedValue(err);
    const res = mockRes();
    const next = vi.fn();
    await ctrl.deleteEmergencyContact(authedReq({ params: { contactId: 'c1' } }), res, next);
    expect(next).toHaveBeenCalledWith(err);
  });



  it('passes ValidationError to next when checkEmergencyInactivity receives invalid date string', async () => {
    const res = mockRes();
    const next = vi.fn();
    await ctrl.checkEmergencyInactivity(authedReq({ body: { now: 'not-a-date' } }), res, next);
    expect(next).toHaveBeenCalledWith(expect.any(ValidationError));
  });

  it('calls search without currentUserId when friendsOnly is not set', async () => {
    service.search.mockResolvedValue([]);
    const res = mockRes();
    const next = vi.fn();
    await ctrl.search(authedReq({ query: { q: 'alice' } }), res, next);
    expect(service.search).toHaveBeenCalledWith('alice', undefined);
  });

  it('calls search with currentUserId when friendsOnly is set', async () => {
    service.search.mockResolvedValue([]);
    const res = mockRes();
    const next = vi.fn();
    await ctrl.search(authedReq({ query: { q: 'alice', friendsOnly: 'true' } }), res, next);
    expect(service.search).toHaveBeenCalledWith('alice', undefined, 'user-1');
  });
});
