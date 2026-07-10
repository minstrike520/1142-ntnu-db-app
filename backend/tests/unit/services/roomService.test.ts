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


import { makeRoomService } from '../../../src/services/roomService';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../../src/errors/AppError';
import type { IRoomRepository } from '../../../src/repositories/IRoomRepository';
import type { IRoomMemberRepository } from '../../../src/repositories/IRoomMemberRepository';
import type { Room, RoomMember } from '../../../../shared/types';
import { saveAvatarUpload, removeManagedAvatar } from '../../../src/lib/avatarUpload';

vi.mock('../../../src/lib/avatarUpload', () => ({
  saveAvatarUpload: vi.fn(),
  removeManagedAvatar: vi.fn(),
}));

vi.mock('../../../src/realtime/presence', () => ({
  isUserOnline: vi.fn().mockReturnValue(false),
}));

describe('roomService', () => {
  let mockRepo: Mocked<IRoomRepository>;
  let mockMemberRepo: Mocked<IRoomMemberRepository>;
  let roomService: ReturnType<typeof makeRoomService>;

  const room: Room = {
    roomId: 'room-1',
    type: 'group',
    name: 'Study Room',
    requireApproval: false,
    viewHistory: true,
    isArchived: false,
    isReadonly: false,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  };

  const ownerMember: RoomMember = {
    roomId: 'room-1',
    userId: 'user-1',
    role: 'owner',
    isMuted: false,
    joinTime: new Date('2026-01-01T00:00:00.000Z'),
  };

  beforeEach(() => {
    mockRepo = {
      findById: vi.fn(),
      findByInviteCode: vi.fn(),
      findPrivateRoomByMembers: vi.fn(),
      findByMember: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    };
    mockMemberRepo = {
      findMember: vi.fn(),
      findByRoom: vi.fn(),
      add: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
      resolveMentions: vi.fn(),
    };
    roomService = makeRoomService(mockRepo, mockMemberRepo);
  });

  it('create validates input, trims name, and applies defaults', async () => {
    mockRepo.create.mockResolvedValue(room);
    mockMemberRepo.add.mockResolvedValue(ownerMember);

    const result = await roomService.create('user-1', { name: '  Study Room  ' });

    expect(mockRepo.create).toHaveBeenCalledWith({
      type: 'group',
      name: 'Study Room',
      inviteCode: expect.any(String),
      requireApproval: false,
      viewHistory: true,
    });
    expect(mockMemberRepo.add).toHaveBeenCalledWith({ roomId: room.roomId, userId: 'user-1', role: 'owner' });
    expect(result).toBe(room);
  });

  it('create rejects empty room names', async () => {
    await expect(roomService.create('user-1', { name: '   ' })).rejects.toThrow(ValidationError);
    expect(mockRepo.create).not.toHaveBeenCalled();
  });

  it('getById returns the room or throws NotFoundError', async () => {
    mockRepo.findById.mockResolvedValueOnce(room);
    mockMemberRepo.findMember.mockResolvedValueOnce(ownerMember);
    await expect(roomService.getById('room-1', 'user-1')).resolves.toBe(room);

    mockRepo.findById.mockResolvedValueOnce(null);
    await expect(roomService.getById('missing-room', 'user-1')).rejects.toThrow(NotFoundError);
  });

  it('list returns rooms for a member', async () => {
    mockRepo.findByMember.mockResolvedValue([room]);

    const result = await roomService.list('user-1');

    expect(mockRepo.findByMember).toHaveBeenCalledWith('user-1');
    expect(result).toEqual([room]);
  });

  it('update validates payload and throws NotFoundError for missing rooms', async () => {
    const updated = { ...room, name: 'Updated Room' };
    mockRepo.findById.mockResolvedValueOnce(room);
    mockMemberRepo.findMember.mockResolvedValueOnce(ownerMember);
    mockRepo.update.mockResolvedValue(updated);

    await expect(roomService.update('room-1', 'user-1', { name: ' Updated Room ' })).resolves.toBe(updated);
    expect(mockRepo.update).toHaveBeenCalledWith('room-1', { name: 'Updated Room' });

    await expect(roomService.update('room-1', 'user-1', {})).rejects.toThrow(ValidationError);

    mockRepo.findById.mockResolvedValueOnce(null);
    await expect(roomService.update('missing-room', 'user-1', { name: 'Nope' })).rejects.toThrow(NotFoundError);
  });

  it('deleteGroup deletes the group for the owner', async () => {
    mockRepo.findById.mockResolvedValueOnce(room);
    mockMemberRepo.findMember.mockResolvedValueOnce(ownerMember);
    await expect(roomService.deleteGroup('room-1', 'user-1')).resolves.toBeUndefined();
    expect(mockRepo.delete).toHaveBeenCalledWith('room-1');
    expect(mockRepo.update).not.toHaveBeenCalled();

    mockRepo.findById.mockResolvedValueOnce(null);
    await expect(roomService.deleteGroup('missing-room', 'user-1')).rejects.toThrow(NotFoundError);
  });

  it('createPrivate returns an existing private room for accepted friends', async () => {
    const socialRepo = {
      isBlocked: vi.fn().mockResolvedValue(false),
      areFriends: vi.fn().mockResolvedValue(true),
    };
    const privateRoom = { ...room, type: 'private' as const };
    mockRepo.findPrivateRoomByMembers.mockResolvedValue(privateRoom);
    roomService = makeRoomService(mockRepo, mockMemberRepo, undefined, socialRepo);

    const result = await roomService.createPrivate('user-1', 'user-2');

    expect(result).toEqual({ room: privateRoom, created: false });
    expect(mockRepo.create).not.toHaveBeenCalled();
  });

  it('createPrivate reopens a readonly private room instead of creating a duplicate', async () => {
    const socialRepo = {
      isBlocked: vi.fn().mockResolvedValue(false),
      areFriends: vi.fn().mockResolvedValue(true),
    };
    const archivedPrivate = {
      ...room,
      type: 'private' as const,
      isReadonly: true,
    };
    const reopenedPrivate = {
      ...archivedPrivate,
      isReadonly: false,
    };
    mockRepo.findPrivateRoomByMembers.mockResolvedValue(archivedPrivate as Room);
    mockRepo.update.mockResolvedValue(reopenedPrivate as Room);
    roomService = makeRoomService(mockRepo, mockMemberRepo, undefined, socialRepo);

    const result = await roomService.createPrivate('user-1', 'user-2');

    expect(mockRepo.update).toHaveBeenCalledWith('room-1', { isReadonly: false });
    expect(result).toEqual({ room: reopenedPrivate, created: false });
  });

  it('createPrivate rejects non-friends', async () => {
    const socialRepo = {
      isBlocked: vi.fn().mockResolvedValue(false),
      areFriends: vi.fn().mockResolvedValue(false),
    };
    roomService = makeRoomService(mockRepo, mockMemberRepo, undefined, socialRepo);

    await expect(roomService.createPrivate('user-1', 'user-2')).rejects.toThrow(ForbiddenError);
    expect(mockRepo.create).not.toHaveBeenCalled();
  });

  it('markPrivateReadOnly sets isReadonly to true', async () => {
    const privateRoom = { ...room, type: 'private' as const };
    mockRepo.findPrivateRoomByMembers.mockResolvedValue(privateRoom as Room);

    await roomService.markPrivateReadOnly('user-1', 'user-2');

    expect(mockRepo.update).toHaveBeenCalledWith('room-1', { isReadonly: true });
  });

  it('reopenPrivateRoom sets isReadonly to false', async () => {
    const readonlyRoom = { ...room, type: 'private' as const, isReadonly: true };
    mockRepo.findPrivateRoomByMembers.mockResolvedValue(readonlyRoom as Room);

    await roomService.reopenPrivateRoom('user-1', 'user-2');

    expect(mockRepo.update).toHaveBeenCalledWith('room-1', { isReadonly: false });
  });

  it('reopenPrivateRoom does nothing when room is not readonly', async () => {
    const openRoom = { ...room, type: 'private' as const, isReadonly: false };
    mockRepo.findPrivateRoomByMembers.mockResolvedValue(openRoom as Room);

    await roomService.reopenPrivateRoom('user-1', 'user-2');

    expect(mockRepo.update).not.toHaveBeenCalled();
  });

  it('reopenPrivateRoom does nothing when room does not exist', async () => {
    mockRepo.findPrivateRoomByMembers.mockResolvedValue(null);

    await roomService.reopenPrivateRoom('user-1', 'user-2');

    expect(mockRepo.update).not.toHaveBeenCalled();
  });
  describe('joinByCode', () => {
    it('joins room using invite code', async () => {
      mockRepo.findByInviteCode.mockResolvedValue(room);
      mockMemberRepo.findMember.mockResolvedValue(null);
      await roomService.joinByCode('user-2', 'ABCDEF');
      expect(mockMemberRepo.add).toHaveBeenCalledWith({ roomId: 'room-1', userId: 'user-2', role: 'member' });
    });
    it('throws ConflictError if already a member', async () => {
      mockRepo.findByInviteCode.mockResolvedValue(room);
      mockMemberRepo.findMember.mockResolvedValue({} as RoomMember);
      await expect(roomService.joinByCode('user-2', 'ABCDEF')).rejects.toThrow(ConflictError);
    });
  });

  describe('leave', () => {
    it('allows normal member to leave', async () => {
      mockRepo.findById.mockResolvedValue(room);
      mockMemberRepo.findMember.mockResolvedValue({ role: 'member' } as RoomMember);
      await roomService.leave('user-2', 'room-1');
      expect(mockMemberRepo.remove).toHaveBeenCalledWith('room-1', 'user-2');
    });
    it('throws ForbiddenError if owner tries to leave', async () => {
      mockRepo.findById.mockResolvedValue(room);
      mockMemberRepo.findMember.mockResolvedValue(ownerMember);
      await expect(roomService.leave('user-1', 'room-1')).rejects.toThrow(ForbiddenError);
    });
  });

  describe('kickMember', () => {
    it('allows owner to kick member', async () => {
      mockRepo.findById.mockResolvedValue(room);
      mockMemberRepo.findMember.mockImplementation(async (roomId, userId) => {
        if (userId === 'user-1') return ownerMember;
        if (userId === 'user-2') return { role: 'member' } as RoomMember;
        return null;
      });
      await roomService.kickMember('room-1', 'user-1', 'user-2');
      expect(mockMemberRepo.remove).toHaveBeenCalledWith('room-1', 'user-2');
    });
    it('prevents kicking the owner', async () => {
      mockRepo.findById.mockResolvedValue(room);
      mockMemberRepo.findMember.mockImplementation(async (roomId, userId) => {
        if (userId === 'user-1') return { role: 'admin' } as RoomMember;
        if (userId === 'user-2') return ownerMember;
        return null;
      });
      await expect(roomService.kickMember('room-1', 'user-1', 'user-2')).rejects.toThrow(ForbiddenError);
    });
  });

  describe('system messages on join/approve', () => {
    let mockUserRepo: any;
    let mockMessageRepo: any;
    let mockEmit: any;

    beforeEach(() => {
      mockUserRepo = {
        findById: vi.fn().mockResolvedValue({ userId: 'user-2', name: 'Bob' }),
      };
      mockMessageRepo = {
        create: vi.fn().mockResolvedValue({ messageId: 'msg-sys', content: '[System] Bob已加入' }),
      };
      mockEmit = vi.fn();
    });

    it('creates system message on direct joinByCode', async () => {
      const service = makeRoomService(
        mockRepo,
        mockMemberRepo,
        mockEmit,
        undefined,
        mockUserRepo,
        mockMessageRepo,
      );

      mockRepo.findByInviteCode.mockResolvedValue(room);
      mockMemberRepo.findMember.mockResolvedValue(null);

      await service.joinByCode('user-2', 'ABCDEF');

      expect(mockUserRepo.findById).toHaveBeenCalledWith('user-2');
      expect(mockMessageRepo.create).toHaveBeenCalledWith({
        roomId: 'room-1',
        senderId: null,
        content: '[System] Bob已加入',
      });
      expect(mockEmit).toHaveBeenCalledWith('room-1', 'new_message', { messageId: 'msg-sys', content: '[System] Bob已加入' });
    });

    it('creates system message on approveMember', async () => {
      const service = makeRoomService(
        mockRepo,
        mockMemberRepo,
        mockEmit,
        undefined,
        mockUserRepo,
        mockMessageRepo,
      );

      mockRepo.findById.mockResolvedValue(room);
      mockMemberRepo.findMember.mockImplementation(async (roomId, userId) => {
        if (userId === 'user-1') return ownerMember; // caller (owner)
        if (userId === 'user-2') return { role: 'pending' } as RoomMember; // target
        return null;
      });

      const approvedRoom = { ...room, requireApproval: true };
      mockRepo.findById.mockResolvedValue(approvedRoom);

      await service.approveMember('room-1', 'user-1', 'user-2');

      expect(mockUserRepo.findById).toHaveBeenCalledWith('user-2');
      expect(mockMessageRepo.create).toHaveBeenCalledWith({
        roomId: 'room-1',
        senderId: null,
        content: '[System] Bob已加入',
      });
      expect(mockEmit).toHaveBeenCalledWith('room-1', 'new_message', { messageId: 'msg-sys', content: '[System] Bob已加入' });
    });
  });

  describe('uploadAvatar', () => {
    let mockFile: any;

    beforeEach(() => {
      mockFile = {
        buffer: Buffer.from('mock-image-data'),
        mimetype: 'image/png',
        originalname: 'avatar.png',
      } as any;

      vi.mocked(saveAvatarUpload).mockReset();
      vi.mocked(removeManagedAvatar).mockReset();
      
      vi.mocked(saveAvatarUpload).mockResolvedValue('/uploads/avatars/new-avatar.png');
    });

    it('updates room avatar successfully by owner', async () => {
      mockRepo.findById.mockResolvedValue(room);
      mockMemberRepo.findMember.mockResolvedValue(ownerMember);
      
      const updatedRoom = { ...room, avatarUrl: '/uploads/avatars/new-avatar.png' };
      mockRepo.update.mockResolvedValue(updatedRoom);

      const result = await roomService.uploadAvatar('room-1', 'user-1', mockFile);

      expect(mockRepo.findById).toHaveBeenCalledWith('room-1');
      expect(mockMemberRepo.findMember).toHaveBeenCalledWith('room-1', 'user-1');
      expect(saveAvatarUpload).toHaveBeenCalledWith('room-1', mockFile);
      expect(mockRepo.update).toHaveBeenCalledWith('room-1', { avatarUrl: '/uploads/avatars/new-avatar.png' });
      expect(result.avatarUrl).toBe('/uploads/avatars/new-avatar.png');
    });

    it('updates room avatar successfully by admin', async () => {
      mockRepo.findById.mockResolvedValue(room);
      mockMemberRepo.findMember.mockResolvedValue({ role: 'admin' } as RoomMember);
      
      const updatedRoom = { ...room, avatarUrl: '/uploads/avatars/new-avatar.png' };
      mockRepo.update.mockResolvedValue(updatedRoom);

      const result = await roomService.uploadAvatar('room-1', 'user-1', mockFile);
      expect(result.avatarUrl).toBe('/uploads/avatars/new-avatar.png');
    });

    it('throws ForbiddenError if caller is normal member', async () => {
      mockRepo.findById.mockResolvedValue(room);
      mockMemberRepo.findMember.mockResolvedValue({ role: 'member' } as RoomMember);

      await expect(roomService.uploadAvatar('room-1', 'user-1', mockFile)).rejects.toThrow(ForbiddenError);
    });

    it('throws NotFoundError if room does not exist', async () => {
      mockRepo.findById.mockResolvedValue(null);

      await expect(roomService.uploadAvatar('room-1', 'user-1', mockFile)).rejects.toThrow(NotFoundError);
    });

    it('throws ValidationError if room is a private room', async () => {
      const privateRoom = { ...room, type: 'private' as const };
      mockRepo.findById.mockResolvedValue(privateRoom);

      await expect(roomService.uploadAvatar('room-1', 'user-1', mockFile)).rejects.toThrow(ValidationError);
    });

    it('deletes newly uploaded avatar and throws error if db update fails', async () => {
      mockRepo.findById.mockResolvedValue(room);
      mockMemberRepo.findMember.mockResolvedValue(ownerMember);
      mockRepo.update.mockRejectedValue(new Error('DB failure'));

      await expect(roomService.uploadAvatar('room-1', 'user-1', mockFile)).rejects.toThrow('DB failure');
      expect(removeManagedAvatar).toHaveBeenCalledWith('/uploads/avatars/new-avatar.png');
    });

    it('deletes old avatar after successful update', async () => {
      const roomWithOldAvatar = { ...room, avatarUrl: '/uploads/avatars/old-avatar.png' };
      mockRepo.findById.mockResolvedValue(roomWithOldAvatar);
      mockMemberRepo.findMember.mockResolvedValue(ownerMember);

      const updatedRoom = { ...room, avatarUrl: '/uploads/avatars/new-avatar.png' };
      mockRepo.update.mockResolvedValue(updatedRoom);

      await roomService.uploadAvatar('room-1', 'user-1', mockFile);

      expect(removeManagedAvatar).toHaveBeenCalledWith('/uploads/avatars/old-avatar.png');
    });
  });

  describe('list with private rooms', () => {
    it('adds isOnline property to private rooms with otherMemberId', async () => {
      const privateRoom = { ...room, type: 'private' as const, otherMemberId: 'user-2' };
      mockRepo.findByMember.mockResolvedValue([privateRoom] as any);
      const result = await roomService.list('user-1');
      expect(result[0]).toHaveProperty('isOnline');
      expect(typeof (result[0] as any).isOnline).toBe('boolean');
    });

    it('returns group rooms without isOnline property', async () => {
      mockRepo.findByMember.mockResolvedValue([room] as any);
      const result = await roomService.list('user-1');
      expect(result[0]).not.toHaveProperty('isOnline');
    });
  });

  describe('createPrivate (new room path)', () => {
    it('creates a new private room and adds both members when none exists', async () => {
      const socialRepo = {
        isBlocked: vi.fn().mockResolvedValue(false),
        areFriends: vi.fn().mockResolvedValue(true),
      };
      const serviceWithSocial = makeRoomService(mockRepo, mockMemberRepo, undefined, socialRepo);
      const newRoom = { ...room, type: 'private' as const };
      mockRepo.findPrivateRoomByMembers.mockResolvedValue(null);
      mockRepo.create.mockResolvedValue(newRoom);
      mockMemberRepo.findMember.mockResolvedValue(null);

      const result = await serviceWithSocial.createPrivate('user-1', 'user-2');

      expect(mockRepo.create).toHaveBeenCalled();
      expect(mockMemberRepo.add).toHaveBeenCalledWith({ roomId: newRoom.roomId, userId: 'user-1', role: 'member' });
      expect(mockMemberRepo.add).toHaveBeenCalledWith({ roomId: newRoom.roomId, userId: 'user-2', role: 'member' });
      expect(result).toEqual({ room: newRoom, created: true });
    });

    it('skips add in ensureMember when member already exists', async () => {
      const socialRepo = {
        isBlocked: vi.fn().mockResolvedValue(false),
        areFriends: vi.fn().mockResolvedValue(true),
      };
      const serviceWithSocial = makeRoomService(mockRepo, mockMemberRepo, undefined, socialRepo);
      const newRoom = { ...room, type: 'private' as const };
      mockRepo.findPrivateRoomByMembers.mockResolvedValue(null);
      mockRepo.create.mockResolvedValue(newRoom);
      mockMemberRepo.findMember.mockResolvedValue(ownerMember);

      await serviceWithSocial.createPrivate('user-1', 'user-2');

      expect(mockMemberRepo.add).not.toHaveBeenCalled();
    });
  });

  describe('listMembers', () => {
    it('returns members when caller is a member', async () => {
      mockRepo.findById.mockResolvedValue(room);
      mockMemberRepo.findMember.mockResolvedValue(ownerMember);
      mockMemberRepo.findByRoom.mockResolvedValue([ownerMember]);

      const result = await roomService.listMembers('room-1', 'user-1');

      expect(result).toEqual([ownerMember]);
    });

    it('throws NotFoundError when room does not exist', async () => {
      mockRepo.findById.mockResolvedValue(null);
      await expect(roomService.listMembers('room-1', 'user-1')).rejects.toThrow(NotFoundError);
    });

    it('throws ForbiddenError when caller is not a member', async () => {
      mockRepo.findById.mockResolvedValue(room);
      mockMemberRepo.findMember.mockResolvedValue(null);
      await expect(roomService.listMembers('room-1', 'user-1')).rejects.toThrow(ForbiddenError);
    });
  });

  describe('update with emitRoomEvent', () => {
    it('emits ROOM_SETTINGS_UPDATED when emitRoomEvent is provided', async () => {
      const emitRoomEvent = vi.fn();
      const serviceWithEmit = makeRoomService(mockRepo, mockMemberRepo, emitRoomEvent);
      const updated = { ...room, name: 'New Name' };
      mockRepo.findById.mockResolvedValue(room);
      mockMemberRepo.findMember.mockResolvedValue(ownerMember);
      mockRepo.update.mockResolvedValue(updated);

      await serviceWithEmit.update('room-1', 'user-1', { name: 'New Name' });

      expect(emitRoomEvent).toHaveBeenCalledWith('room-1', 'room_update', { type: 'ROOM_SETTINGS_UPDATED', data: updated });
    });
  });

  describe('leave with emitRoomEvent and system message', () => {
    it('emits MEMBER_LEFT when emitRoomEvent is provided', async () => {
      const emitRoomEvent = vi.fn();
      const serviceWithEmit = makeRoomService(mockRepo, mockMemberRepo, emitRoomEvent);
      mockRepo.findById.mockResolvedValue(room);
      mockMemberRepo.findMember.mockResolvedValue({ ...ownerMember, role: 'member' } as RoomMember);

      await serviceWithEmit.leave('user-2', 'room-1');

      expect(emitRoomEvent).toHaveBeenCalledWith('room-1', 'room_update', { type: 'MEMBER_LEFT', data: { userId: 'user-2' } });
    });

    it('creates system message and emits new_message when userRepo and messageRepo are provided', async () => {
      const emitRoomEvent = vi.fn();
      const userRepo = { findById: vi.fn().mockResolvedValue({ userId: 'user-2', name: 'Bob' }) };
      const messageRepo = { create: vi.fn().mockResolvedValue({ messageId: 'msg-1' }) };
      const serviceWithAll = makeRoomService(mockRepo, mockMemberRepo, emitRoomEvent, undefined, userRepo as any, messageRepo as any);
      mockRepo.findById.mockResolvedValue(room);
      mockMemberRepo.findMember.mockResolvedValue({ ...ownerMember, role: 'member' } as RoomMember);

      await serviceWithAll.leave('user-2', 'room-1');

      expect(messageRepo.create).toHaveBeenCalledWith(expect.objectContaining({ content: '[System] Bob已離開' }));
      expect(emitRoomEvent).toHaveBeenCalledWith('room-1', 'new_message', expect.anything());
    });
  });

  describe('transferOwnership', () => {
    it('demotes caller to admin and promotes target to owner', async () => {
      mockRepo.findById.mockResolvedValue(room);
      mockMemberRepo.findMember
        .mockResolvedValueOnce(ownerMember)
        .mockResolvedValueOnce({ ...ownerMember, userId: 'user-2', role: 'member' } as RoomMember);
      mockMemberRepo.update.mockResolvedValue(ownerMember);

      await roomService.transferOwnership('room-1', 'user-1', 'user-2');

      expect(mockMemberRepo.update).toHaveBeenCalledWith('room-1', 'user-1', { role: 'admin' });
      expect(mockMemberRepo.update).toHaveBeenCalledWith('room-1', 'user-2', { role: 'owner' });
    });

    it('throws NotFoundError when room does not exist', async () => {
      mockRepo.findById.mockResolvedValue(null);
      await expect(roomService.transferOwnership('room-1', 'user-1', 'user-2')).rejects.toThrow(NotFoundError);
    });

    it('throws ValidationError for private rooms', async () => {
      mockRepo.findById.mockResolvedValue({ ...room, type: 'private' as const });
      await expect(roomService.transferOwnership('room-1', 'user-1', 'user-2')).rejects.toThrow(ValidationError);
    });

    it('throws ForbiddenError when caller is not a member', async () => {
      mockRepo.findById.mockResolvedValue(room);
      mockMemberRepo.findMember.mockResolvedValueOnce(null);
      await expect(roomService.transferOwnership('room-1', 'user-1', 'user-2')).rejects.toThrow(ForbiddenError);
    });

    it('throws ForbiddenError when caller is not owner', async () => {
      mockRepo.findById.mockResolvedValue(room);
      mockMemberRepo.findMember.mockResolvedValueOnce({ ...ownerMember, role: 'admin' } as RoomMember);
      await expect(roomService.transferOwnership('room-1', 'user-1', 'user-2')).rejects.toThrow(ForbiddenError);
    });

    it('throws NotFoundError when target is not a member', async () => {
      mockRepo.findById.mockResolvedValue(room);
      mockMemberRepo.findMember
        .mockResolvedValueOnce(ownerMember)
        .mockResolvedValueOnce(null);
      await expect(roomService.transferOwnership('room-1', 'user-1', 'user-2')).rejects.toThrow(NotFoundError);
    });

    it('throws ValidationError when target is pending', async () => {
      mockRepo.findById.mockResolvedValue(room);
      mockMemberRepo.findMember
        .mockResolvedValueOnce(ownerMember)
        .mockResolvedValueOnce({ ...ownerMember, userId: 'user-2', role: 'pending' } as RoomMember);
      await expect(roomService.transferOwnership('room-1', 'user-1', 'user-2')).rejects.toThrow(ValidationError);
    });

    it('emits OWNERSHIP_TRANSFERRED event when emitRoomEvent is provided', async () => {
      const emitRoomEvent = vi.fn();
      const serviceWithEmit = makeRoomService(mockRepo, mockMemberRepo, emitRoomEvent);
      mockRepo.findById.mockResolvedValue(room);
      mockMemberRepo.findMember
        .mockResolvedValueOnce(ownerMember)
        .mockResolvedValueOnce({ ...ownerMember, userId: 'user-2', role: 'member' } as RoomMember);
      mockMemberRepo.update.mockResolvedValue(ownerMember);

      await serviceWithEmit.transferOwnership('room-1', 'user-1', 'user-2');

      expect(emitRoomEvent).toHaveBeenCalledWith('room-1', 'room_update', {
        type: 'OWNERSHIP_TRANSFERRED',
        data: { oldOwner: 'user-1', newOwner: 'user-2' },
      });
    });
  });

  describe('deleteGroup with emitRoomEvent', () => {
    it('emits ROOM_DELETED event when emitRoomEvent is provided', async () => {
      const emitRoomEvent = vi.fn();
      const serviceWithEmit = makeRoomService(mockRepo, mockMemberRepo, emitRoomEvent);
      mockRepo.findById.mockResolvedValue(room);
      mockMemberRepo.findMember.mockResolvedValue(ownerMember);

      await serviceWithEmit.deleteGroup('room-1', 'user-1');

      expect(emitRoomEvent).toHaveBeenCalledWith('room-1', 'room_update', { type: 'ROOM_DELETED', data: { roomId: 'room-1' } });
    });
  });

  describe('updateMember', () => {
    it('throws NotFoundError when room does not exist', async () => {
      mockRepo.findById.mockResolvedValue(null);
      await expect(roomService.updateMember('room-1', 'user-1', 'user-2', {})).rejects.toThrow(NotFoundError);
    });

    it('throws ForbiddenError when caller is not a member', async () => {
      mockRepo.findById.mockResolvedValue(room);
      mockMemberRepo.findMember.mockResolvedValueOnce(null);
      await expect(roomService.updateMember('room-1', 'user-1', 'user-2', {})).rejects.toThrow(ForbiddenError);
    });

    it('throws NotFoundError when target is not a member', async () => {
      mockRepo.findById.mockResolvedValue(room);
      mockMemberRepo.findMember
        .mockResolvedValueOnce(ownerMember)
        .mockResolvedValueOnce(null);
      await expect(roomService.updateMember('room-1', 'user-1', 'user-2', {})).rejects.toThrow(NotFoundError);
    });

    it('throws ForbiddenError when regular member tries to update another member', async () => {
      mockRepo.findById.mockResolvedValue(room);
      mockMemberRepo.findMember
        .mockResolvedValueOnce({ ...ownerMember, role: 'member' } as RoomMember)
        .mockResolvedValueOnce({ ...ownerMember, userId: 'user-2', role: 'member' } as RoomMember);
      await expect(roomService.updateMember('room-1', 'user-1', 'user-2', { nickname: 'Bob' })).rejects.toThrow(ForbiddenError);
    });

    it('throws ForbiddenError when admin tries to update owner or another admin', async () => {
      mockRepo.findById.mockResolvedValue(room);
      mockMemberRepo.findMember
        .mockResolvedValueOnce({ ...ownerMember, role: 'admin' } as RoomMember)
        .mockResolvedValueOnce(ownerMember);
      await expect(roomService.updateMember('room-1', 'user-1', 'user-2', { nickname: 'Bob' })).rejects.toThrow(ForbiddenError);
    });

    it('throws ForbiddenError when admin tries to change role', async () => {
      mockRepo.findById.mockResolvedValue(room);
      mockMemberRepo.findMember
        .mockResolvedValueOnce({ ...ownerMember, role: 'admin' } as RoomMember)
        .mockResolvedValueOnce({ ...ownerMember, userId: 'user-2', role: 'member' } as RoomMember);
      await expect(roomService.updateMember('room-1', 'user-1', 'user-2', { role: 'admin' })).rejects.toThrow(ForbiddenError);
    });

    it('throws ForbiddenError when user tries to update their own role', async () => {
      mockRepo.findById.mockResolvedValue(room);
      mockMemberRepo.findMember.mockResolvedValue({ ...ownerMember, role: 'member' } as RoomMember);
      await expect(roomService.updateMember('room-1', 'user-1', 'user-1', { role: 'admin' })).rejects.toThrow(ForbiddenError);
    });

    it('throws ForbiddenError when user tries to mute themselves', async () => {
      mockRepo.findById.mockResolvedValue(room);
      mockMemberRepo.findMember.mockResolvedValue({ ...ownerMember, role: 'member' } as RoomMember);
      await expect(roomService.updateMember('room-1', 'user-1', 'user-1', { isMuted: true })).rejects.toThrow(ForbiddenError);
    });

    it('allows member to update their own nickname', async () => {
      mockRepo.findById.mockResolvedValue(room);
      mockMemberRepo.findMember.mockResolvedValue({ ...ownerMember, role: 'member' } as RoomMember);
      mockMemberRepo.update.mockResolvedValue(ownerMember);

      await roomService.updateMember('room-1', 'user-1', 'user-1', { nickname: 'New Nick' });

      expect(mockMemberRepo.update).toHaveBeenCalledWith('room-1', 'user-1', { nickname: 'New Nick' });
    });

    it('owner can update another member and emits MEMBER_UPDATED event', async () => {
      const emitRoomEvent = vi.fn();
      const serviceWithEmit = makeRoomService(mockRepo, mockMemberRepo, emitRoomEvent);
      mockRepo.findById.mockResolvedValue(room);
      mockMemberRepo.findMember
        .mockResolvedValueOnce(ownerMember)
        .mockResolvedValueOnce({ ...ownerMember, userId: 'user-2', role: 'member' } as RoomMember);
      mockMemberRepo.update.mockResolvedValue(ownerMember);

      await serviceWithEmit.updateMember('room-1', 'user-1', 'user-2', { nickname: 'Bob' });

      expect(mockMemberRepo.update).toHaveBeenCalledWith('room-1', 'user-2', { nickname: 'Bob' });
      expect(emitRoomEvent).toHaveBeenCalledWith('room-1', 'room_update', {
        type: 'MEMBER_UPDATED',
        data: { userId: 'user-2', nickname: 'Bob' },
      });
    });
  });

  describe('kickMember with emitRoomEvent and system message', () => {
    it('emits MEMBER_KICKED when emitRoomEvent is provided', async () => {
      const emitRoomEvent = vi.fn();
      const serviceWithEmit = makeRoomService(mockRepo, mockMemberRepo, emitRoomEvent);
      mockRepo.findById.mockResolvedValue(room);
      mockMemberRepo.findMember
        .mockResolvedValueOnce(ownerMember)
        .mockResolvedValueOnce({ ...ownerMember, userId: 'user-2', role: 'member' } as RoomMember);

      await serviceWithEmit.kickMember('room-1', 'user-1', 'user-2');

      expect(emitRoomEvent).toHaveBeenCalledWith('room-1', 'room_update', { type: 'MEMBER_KICKED', data: { userId: 'user-2' } });
    });

    it('creates system message when userRepo and messageRepo are provided', async () => {
      const emitRoomEvent = vi.fn();
      const userRepo = { findById: vi.fn().mockResolvedValue({ userId: 'user-2', name: 'Bob' }) };
      const messageRepo = { create: vi.fn().mockResolvedValue({ messageId: 'msg-1' }) };
      const serviceWithAll = makeRoomService(mockRepo, mockMemberRepo, emitRoomEvent, undefined, userRepo as any, messageRepo as any);
      mockRepo.findById.mockResolvedValue(room);
      mockMemberRepo.findMember
        .mockResolvedValueOnce(ownerMember)
        .mockResolvedValueOnce({ ...ownerMember, userId: 'user-2', role: 'member' } as RoomMember);

      await serviceWithAll.kickMember('room-1', 'user-1', 'user-2');

      expect(messageRepo.create).toHaveBeenCalledWith(expect.objectContaining({ content: '[System] Bob已被移出群組' }));
    });
  });

  describe('uploadAvatar with emitRoomEvent', () => {
    it('emits ROOM_AVATAR_UPDATED event when emitRoomEvent is provided', async () => {
      const emitRoomEvent = vi.fn();
      const serviceWithEmit = makeRoomService(mockRepo, mockMemberRepo, emitRoomEvent);
      vi.mocked(saveAvatarUpload).mockResolvedValue('/uploads/avatars/new.png');
      const updated = { ...room, avatarUrl: '/uploads/avatars/new.png' };
      mockRepo.findById.mockResolvedValue(room);
      mockMemberRepo.findMember.mockResolvedValue(ownerMember);
      mockRepo.update.mockResolvedValue(updated);

      await serviceWithEmit.uploadAvatar('room-1', 'user-1', {} as any);

      expect(emitRoomEvent).toHaveBeenCalledWith('room-1', 'room_update', {
        type: 'ROOM_AVATAR_UPDATED',
        data: { roomId: 'room-1', avatarUrl: '/uploads/avatars/new.png' },
      });
    });
  });

  describe('createPrivate errors', () => {
    it('throws ValidationError when creatorId equals targetUserId', async () => {
      await expect(roomService.createPrivate('user-1', 'user-1')).rejects.toThrow(ValidationError);
    });

    it('throws ForbiddenError when no socialRepo is provided', async () => {
      await expect(roomService.createPrivate('user-1', 'user-2')).rejects.toThrow(ForbiddenError);
    });

    it('throws ForbiddenError when socialRepo.isBlocked returns true', async () => {
      const socialRepo = {
        isBlocked: vi.fn().mockResolvedValue(true),
        areFriends: vi.fn().mockResolvedValue(true),
      };
      const serviceWithSocial = makeRoomService(mockRepo, mockMemberRepo, undefined, socialRepo);
      await expect(serviceWithSocial.createPrivate('user-1', 'user-2')).rejects.toThrow(ForbiddenError);
    });
  });

  describe('update not authorized', () => {
    it('throws ForbiddenError when caller is not a member of the room', async () => {
      mockRepo.findById.mockResolvedValue(room);
      mockMemberRepo.findMember.mockResolvedValue(null);
      await expect(roomService.update('room-1', 'user-1', { name: 'New' })).rejects.toThrow(ForbiddenError);
    });

    it('throws ForbiddenError when caller is a regular member (not admin or owner)', async () => {
      mockRepo.findById.mockResolvedValue(room);
      mockMemberRepo.findMember.mockResolvedValue({ ...ownerMember, role: 'member' } as RoomMember);
      await expect(roomService.update('room-1', 'user-1', { name: 'New' })).rejects.toThrow(ForbiddenError);
    });
  });

  describe('approveMember error paths', () => {
    const approvalRoom = { ...room, requireApproval: true };

    it('throws NotFoundError when room does not exist', async () => {
      mockRepo.findById.mockResolvedValue(null);
      await expect(roomService.approveMember('room-1', 'user-1', 'user-2')).rejects.toThrow(NotFoundError);
    });

    it('throws ValidationError when room does not require approval', async () => {
      mockRepo.findById.mockResolvedValue(room);
      await expect(roomService.approveMember('room-1', 'user-1', 'user-2')).rejects.toThrow(ValidationError);
    });

    it('throws ForbiddenError when caller is not a member', async () => {
      mockRepo.findById.mockResolvedValue(approvalRoom);
      mockMemberRepo.findMember.mockResolvedValueOnce(null);
      await expect(roomService.approveMember('room-1', 'user-1', 'user-2')).rejects.toThrow(ForbiddenError);
    });

    it('throws ForbiddenError when caller is a regular member (not admin or owner)', async () => {
      mockRepo.findById.mockResolvedValue(approvalRoom);
      mockMemberRepo.findMember.mockResolvedValueOnce({ ...ownerMember, role: 'member' } as RoomMember);
      await expect(roomService.approveMember('room-1', 'user-1', 'user-2')).rejects.toThrow(ForbiddenError);
    });

    it('throws NotFoundError when target user is not a member', async () => {
      mockRepo.findById.mockResolvedValue(approvalRoom);
      mockMemberRepo.findMember
        .mockResolvedValueOnce(ownerMember)
        .mockResolvedValueOnce(null);
      await expect(roomService.approveMember('room-1', 'user-1', 'user-2')).rejects.toThrow(NotFoundError);
    });

    it('throws ValidationError when target member is not pending', async () => {
      mockRepo.findById.mockResolvedValue(approvalRoom);
      mockMemberRepo.findMember
        .mockResolvedValueOnce(ownerMember)
        .mockResolvedValueOnce({ ...ownerMember, userId: 'user-2', role: 'member' } as RoomMember);
      await expect(roomService.approveMember('room-1', 'user-1', 'user-2')).rejects.toThrow(ValidationError);
    });
  });

  describe('kickMember error paths', () => {
    it('throws NotFoundError when room does not exist', async () => {
      mockRepo.findById.mockResolvedValue(null);
      await expect(roomService.kickMember('room-1', 'user-1', 'user-2')).rejects.toThrow(NotFoundError);
    });

    it('throws ForbiddenError when caller is a regular member (not admin or owner)', async () => {
      mockRepo.findById.mockResolvedValue(room);
      mockMemberRepo.findMember.mockResolvedValueOnce({ ...ownerMember, role: 'member' } as RoomMember);
      await expect(roomService.kickMember('room-1', 'user-1', 'user-2')).rejects.toThrow(ForbiddenError);
    });

    it('throws NotFoundError when target user is not a member', async () => {
      mockRepo.findById.mockResolvedValue(room);
      mockMemberRepo.findMember
        .mockResolvedValueOnce(ownerMember)
        .mockResolvedValueOnce(null);
      await expect(roomService.kickMember('room-1', 'user-1', 'user-2')).rejects.toThrow(NotFoundError);
    });

    it('throws ForbiddenError when owner tries to kick another owner', async () => {
      mockRepo.findById.mockResolvedValue(room);
      mockMemberRepo.findMember
        .mockResolvedValueOnce(ownerMember)
        .mockResolvedValueOnce({ ...ownerMember, userId: 'user-2', role: 'owner' } as RoomMember);
      await expect(roomService.kickMember('room-1', 'user-1', 'user-2')).rejects.toThrow(ForbiddenError);
    });
  });
});
