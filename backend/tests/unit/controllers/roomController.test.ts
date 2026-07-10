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


import { makeRoomController } from '../../../src/controllers/roomController';
import { ValidationError } from '../../../src/errors/AppError';
import type { Request, Response, NextFunction } from 'express';

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

describe('roomController', () => {
  const room = {
    roomId: 'room-1',
    type: 'group',
    name: 'Study Room',
    requireApproval: false,
    viewHistory: true,
    isArchived: false,
    createdAt: new Date('2026-01-01'),
  };

  const service = {
    list: vi.fn(),
    create: vi.fn(),
    createPrivate: vi.fn(),
    getById: vi.fn(),
    listMembers: vi.fn(),
    update: vi.fn(),
    deleteGroup: vi.fn(),
    joinByCode: vi.fn(),
    leave: vi.fn(),
    approveMember: vi.fn(),
    updateMember: vi.fn(),
    kickMember: vi.fn(),
    transferOwnership: vi.fn(),
    uploadAvatar: vi.fn(),
  };
  const ctrl = makeRoomController(service);

  beforeEach(() => vi.clearAllMocks());

  describe('list', () => {
    it('returns 200 with rooms', async () => {
      service.list.mockResolvedValue([room]);
      const res = mockRes();
      const next = vi.fn();

      await ctrl.list(authedReq(), res, next);

      expect(service.list).toHaveBeenCalledWith('user-1');
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith([room]);
    });

    it('calls next with error when service throws', async () => {
      service.list.mockRejectedValue(new Error('db error'));
      const res = mockRes();
      const next = vi.fn();

      await ctrl.list(authedReq(), res, next);

      expect(next).toHaveBeenCalledWith(expect.any(Error));
    });
  });

  describe('create (group)', () => {
    it('returns 201 with room on valid name', async () => {
      service.create.mockResolvedValue(room);
      const res = mockRes();
      const next = vi.fn();

      await ctrl.create(authedReq({ body: { type: 'group', name: 'Study Room' } }), res, next);

      expect(service.create).toHaveBeenCalledWith('user-1', {
        type: 'group',
        name: 'Study Room',
        avatarUrl: undefined,
        requireApproval: undefined,
        viewHistory: undefined,
      });
      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith(room);
    });

    it('calls next with ValidationError when name is empty', async () => {
      const res = mockRes();
      const next = vi.fn();

      await ctrl.create(authedReq({ body: { type: 'group', name: '   ' } }), res, next);

      expect(next).toHaveBeenCalledWith(expect.any(ValidationError));
      expect(res.status).not.toHaveBeenCalled();
    });

    it('calls next with ValidationError when name is missing', async () => {
      const res = mockRes();
      const next = vi.fn();

      await ctrl.create(authedReq({ body: { type: 'group' } }), res, next);

      expect(next).toHaveBeenCalledWith(expect.any(ValidationError));
    });

    it('calls next with error when service throws', async () => {
      service.create.mockRejectedValue(new Error('db error'));
      const res = mockRes();
      const next = vi.fn();

      await ctrl.create(authedReq({ body: { type: 'group', name: 'Study Room' } }), res, next);

      expect(next).toHaveBeenCalledWith(expect.any(Error));
    });
  });

  describe('getById', () => {
    it('returns 200 with room', async () => {
      service.getById.mockResolvedValue(room);
      const res = mockRes();
      const next = vi.fn();

      await ctrl.getById(authedReq({ params: { id: 'room-1' } }), res, next);

      expect(service.getById).toHaveBeenCalledWith('room-1', 'user-1');
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(room);
    });

    it('calls next with error when service throws', async () => {
      service.getById.mockRejectedValue(new Error('not found'));
      const res = mockRes();
      const next = vi.fn();

      await ctrl.getById(authedReq({ params: { id: 'room-1' } }), res, next);

      expect(next).toHaveBeenCalledWith(expect.any(Error));
    });
  });

  describe('create (private)', () => {
    it('returns 201 when a private room is newly created', async () => {
      const privateRoom = { ...room, type: 'private' as const, name: undefined };
      service.createPrivate.mockResolvedValue({ room: privateRoom, created: true });
      const res = mockRes();
      const next = vi.fn();

      await ctrl.create(authedReq({ body: { type: 'private', targetUserId: 'user-2' } }), res, next);

      expect(service.createPrivate).toHaveBeenCalledWith('user-1', 'user-2');
      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith(privateRoom);
    });

    it('returns 200 when an existing private room is reused', async () => {
      const privateRoom = { ...room, type: 'private' as const, name: undefined };
      service.createPrivate.mockResolvedValue({ room: privateRoom, created: false });
      const res = mockRes();
      const next = vi.fn();

      await ctrl.create(authedReq({ body: { type: 'private', targetUserId: 'user-2' } }), res, next);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(privateRoom);
    });
  });

  describe('update', () => {
    it('returns 200 with updated room', async () => {
      const updated = { ...room, name: 'New Name' };
      service.update.mockResolvedValue(updated);
      const res = mockRes();
      const next = vi.fn();

      await ctrl.update(authedReq({ params: { id: 'room-1' }, body: { name: 'New Name' } }), res, next);

      expect(service.update).toHaveBeenCalledWith('room-1', 'user-1', { name: 'New Name' });
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(updated);
    });

    it('calls next with error when service throws', async () => {
      service.update.mockRejectedValue(new Error('forbidden'));
      const res = mockRes();
      const next = vi.fn();

      await ctrl.update(authedReq({ params: { id: 'room-1' }, body: { name: 'X' } }), res, next);

      expect(next).toHaveBeenCalledWith(expect.any(Error));
    });
  });

  describe('join', () => {
    it('returns 200 with room', async () => {
      service.joinByCode.mockResolvedValue(room);
      const res = mockRes();
      const next = vi.fn();

      await ctrl.join(authedReq({ body: { inviteCode: 'ABC123' } }), res, next);

      expect(service.joinByCode).toHaveBeenCalledWith('user-1', 'ABC123');
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(room);
    });

    it('calls next with error when service throws', async () => {
      service.joinByCode.mockRejectedValue(new Error('invalid code'));
      const res = mockRes();
      const next = vi.fn();

      await ctrl.join(authedReq({ body: { inviteCode: 'BAD' } }), res, next);

      expect(next).toHaveBeenCalledWith(expect.any(Error));
    });
  });

  describe('leave', () => {
    it('returns 204', async () => {
      service.leave.mockResolvedValue(undefined);
      const res = mockRes();
      const next = vi.fn();

      await ctrl.leave(authedReq({ params: { id: 'room-1' } }), res, next);

      expect(service.leave).toHaveBeenCalledWith('user-1', 'room-1');
      expect(res.status).toHaveBeenCalledWith(204);
      expect(res.send).toHaveBeenCalled();
    });

    it('calls next with error when service throws', async () => {
      service.leave.mockRejectedValue(new Error('forbidden'));
      const res = mockRes();
      const next = vi.fn();

      await ctrl.leave(authedReq({ params: { id: 'room-1' } }), res, next);

      expect(next).toHaveBeenCalledWith(expect.any(Error));
    });
  });

  describe('deleteGroup', () => {
    it('returns 204', async () => {
      service.deleteGroup.mockResolvedValue(undefined);
      const res = mockRes();
      const next = vi.fn();

      await ctrl.deleteGroup(authedReq({ params: { id: 'room-1' } }), res, next);

      expect(service.deleteGroup).toHaveBeenCalledWith('room-1', 'user-1');
      expect(res.status).toHaveBeenCalledWith(204);
      expect(res.send).toHaveBeenCalled();
    });

    it('calls next with error when service throws', async () => {
      service.deleteGroup.mockRejectedValue(new Error('forbidden'));
      const res = mockRes();
      const next = vi.fn();

      await ctrl.deleteGroup(authedReq({ params: { id: 'room-1' } }), res, next);

      expect(next).toHaveBeenCalledWith(expect.any(Error));
    });
  });

  describe('create (private type branches)', () => {
    it('returns ValidationError when private type missing targetUserId', async () => {
      const res = mockRes();
      const next = vi.fn();

      await ctrl.create(authedReq({ body: { type: 'private' } }), res, next);

      expect(next).toHaveBeenCalledWith(expect.any(ValidationError));
    });

    it('returns ValidationError for unknown room type', async () => {
      const res = mockRes();
      const next = vi.fn();

      await ctrl.create(authedReq({ body: { type: 'unknown' } }), res, next);

      expect(next).toHaveBeenCalledWith(expect.any(ValidationError));
    });

    it('creates private room and returns 201 when new', async () => {
      service.createPrivate.mockResolvedValue({ room, created: true });
      const res = mockRes();
      const next = vi.fn();

      await ctrl.create(authedReq({ body: { type: 'private', targetUserId: 'user-2' } }), res, next);

      expect(service.createPrivate).toHaveBeenCalledWith('user-1', 'user-2');
      expect(res.status).toHaveBeenCalledWith(201);
    });

    it('creates private room and returns 200 when existing', async () => {
      service.createPrivate.mockResolvedValue({ room, created: false });
      const res = mockRes();
      const next = vi.fn();

      await ctrl.create(authedReq({ body: { type: 'private', targetUserId: 'user-2' } }), res, next);

      expect(res.status).toHaveBeenCalledWith(200);
    });
  });

  describe('listMembers', () => {
    it('returns 200 with members', async () => {
      const members = [{ userId: 'user-1', role: 'owner' }];
      service.listMembers.mockResolvedValue(members);
      const res = mockRes();
      const next = vi.fn();

      await ctrl.listMembers(authedReq({ params: { id: 'room-1' } }), res, next);

      expect(service.listMembers).toHaveBeenCalledWith('room-1', 'user-1');
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(members);
    });

    it('passes errors to next', async () => {
      service.listMembers.mockRejectedValue(new Error('forbidden'));
      const res = mockRes();
      const next = vi.fn();

      await ctrl.listMembers(authedReq({ params: { id: 'room-1' } }), res, next);

      expect(next).toHaveBeenCalledWith(expect.any(Error));
    });
  });

  describe('update (transferOwnership path)', () => {
    it('delegates to transferOwnership when ownerId is present in body', async () => {
      service.transferOwnership.mockResolvedValue(undefined);
      const res = mockRes();
      const next = vi.fn();

      await ctrl.update(authedReq({ params: { id: 'room-1' }, body: { ownerId: 'user-2' } }), res, next);

      expect(service.transferOwnership).toHaveBeenCalledWith('room-1', 'user-1', 'user-2');
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ message: 'Ownership transferred' });
    });
  });

  describe('transferOwnership handler', () => {
    it('returns 200 on success', async () => {
      service.transferOwnership.mockResolvedValue(undefined);
      const res = mockRes();
      const next = vi.fn();

      await ctrl.transferOwnership(authedReq({ params: { id: 'room-1' }, body: { targetUserId: 'user-2' } }), res, next);

      expect(service.transferOwnership).toHaveBeenCalledWith('room-1', 'user-1', 'user-2');
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('passes ValidationError to next when targetUserId is missing', async () => {
      const res = mockRes();
      const next = vi.fn();

      await ctrl.transferOwnership(authedReq({ params: { id: 'room-1' }, body: {} }), res, next);

      expect(next).toHaveBeenCalledWith(expect.any(ValidationError));
    });

    it('passes service errors to next', async () => {
      service.transferOwnership.mockRejectedValue(new Error('forbidden'));
      const res = mockRes();
      const next = vi.fn();

      await ctrl.transferOwnership(authedReq({ params: { id: 'room-1' }, body: { targetUserId: 'user-2' } }), res, next);

      expect(next).toHaveBeenCalledWith(expect.any(Error));
    });
  });

  describe('approveMember', () => {
    it('returns 200 on success', async () => {
      service.approveMember.mockResolvedValue(undefined);
      const res = mockRes();
      const next = vi.fn();

      await ctrl.approveMember(authedReq({ params: { id: 'room-1', userId: 'user-2' } }), res, next);

      expect(service.approveMember).toHaveBeenCalledWith('room-1', 'user-1', 'user-2');
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ message: 'Member approved' });
    });

    it('passes service errors to next', async () => {
      service.approveMember.mockRejectedValue(new Error('forbidden'));
      const res = mockRes();
      const next = vi.fn();

      await ctrl.approveMember(authedReq({ params: { id: 'room-1', userId: 'user-2' } }), res, next);

      expect(next).toHaveBeenCalledWith(expect.any(Error));
    });
  });

  describe('updateMember handler', () => {
    it('delegates to approveMember and returns 200 when status is approved', async () => {
      service.approveMember.mockResolvedValue(undefined);
      const res = mockRes();
      const next = vi.fn();

      await ctrl.updateMember(
        authedReq({ params: { id: 'room-1', userId: 'user-2' }, body: { status: 'approved' } }),
        res,
        next,
      );

      expect(service.approveMember).toHaveBeenCalledWith('room-1', 'user-1', 'user-2');
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ message: 'Member approved' });
    });

    it('delegates to updateMember and returns 200 when status is not approved', async () => {
      service.updateMember.mockResolvedValue(undefined);
      const res = mockRes();
      const next = vi.fn();

      await ctrl.updateMember(
        authedReq({ params: { id: 'room-1', userId: 'user-2' }, body: { nickname: 'Bob' } }),
        res,
        next,
      );

      expect(service.updateMember).toHaveBeenCalledWith('room-1', 'user-1', 'user-2', { nickname: 'Bob' });
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ message: 'Member updated' });
    });

    it('passes service errors to next', async () => {
      service.updateMember.mockRejectedValue(new Error('forbidden'));
      const res = mockRes();
      const next = vi.fn();

      await ctrl.updateMember(
        authedReq({ params: { id: 'room-1', userId: 'user-2' }, body: {} }),
        res,
        next,
      );

      expect(next).toHaveBeenCalledWith(expect.any(Error));
    });
  });

  describe('kickMember handler', () => {
    it('returns 204 on success', async () => {
      service.kickMember.mockResolvedValue(undefined);
      const res = mockRes();
      const next = vi.fn();

      await ctrl.kickMember(authedReq({ params: { id: 'room-1', userId: 'user-2' } }), res, next);

      expect(service.kickMember).toHaveBeenCalledWith('room-1', 'user-1', 'user-2');
      expect(res.status).toHaveBeenCalledWith(204);
      expect(res.send).toHaveBeenCalled();
    });

    it('passes service errors to next', async () => {
      service.kickMember.mockRejectedValue(new Error('forbidden'));
      const res = mockRes();
      const next = vi.fn();

      await ctrl.kickMember(authedReq({ params: { id: 'room-1', userId: 'user-2' } }), res, next);

      expect(next).toHaveBeenCalledWith(expect.any(Error));
    });
  });

  describe('uploadAvatar handler (room)', () => {
    it('returns 200 with updated room on success', async () => {
      const updatedRoom = { ...room, avatarUrl: '/uploads/avatars/room-1.png' };
      service.uploadAvatar.mockResolvedValue(updatedRoom);
      const res = mockRes();
      const next = vi.fn();
      const file = { originalname: 'room.png', buffer: Buffer.from([]) } as Express.Multer.File;

      await ctrl.uploadAvatar(authedReq({ params: { id: 'room-1' }, file }), res, next);

      expect(service.uploadAvatar).toHaveBeenCalledWith('room-1', 'user-1', file);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(updatedRoom);
    });

    it('passes ValidationError to next when no file is provided', async () => {
      const res = mockRes();
      const next = vi.fn();

      await ctrl.uploadAvatar(authedReq({ params: { id: 'room-1' } }), res, next);

      expect(next).toHaveBeenCalledWith(expect.any(ValidationError));
      expect(service.uploadAvatar).not.toHaveBeenCalled();
    });

    it('passes service errors to next', async () => {
      service.uploadAvatar.mockRejectedValue(new Error('storage error'));
      const res = mockRes();
      const next = vi.fn();
      const file = { originalname: 'room.png', buffer: Buffer.from([]) } as Express.Multer.File;

      await ctrl.uploadAvatar(authedReq({ params: { id: 'room-1' }, file }), res, next);

      expect(next).toHaveBeenCalledWith(expect.any(Error));
    });
  });
});
