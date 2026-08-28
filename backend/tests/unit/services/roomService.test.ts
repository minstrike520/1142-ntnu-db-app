import { describe, it, expect, beforeEach, mock, type Mock } from 'bun:test';
import { makeRoomService } from '../../../src/services/roomService';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../../src/utils/AppError';
import type { IRoomRepository } from '../../../src/models/IRoomRepository';
import type { IRoomMemberRepository } from '../../../src/models/IRoomMemberRepository';
import type { Room, RoomMember } from '../../../../shared/types';

// Injected below rather than `mock.module`'d, for the same reason as
// `avatarStore`: a module mock is process-global within a tier and cannot be
// undone. See backend/tests/CLAUDE.md and issue #467.
const readOnlineAmong = mock(async () => new Set<string>());

type Mocked<T> = {
  [P in keyof T]: T[P] extends Function ? Mock<any> : T[P];
};

describe('roomService', () => {
  let mockRepo: Mocked<IRoomRepository>;
  let mockMemberRepo: Mocked<IRoomMemberRepository>;
  let roomService: ReturnType<typeof makeRoomService>;
  // Injected instead of `mock.module('../../../src/utils/avatarUpload', ...)`:
  // module mocks are process-global in Bun and cannot be undone, so stubbing
  // the module here also stubbed it for avatarUpload.test.ts. See issue #467.
  let avatarStore: any;

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
      findById: mock(),
      findByInviteCode: mock(),
      findPrivateRoomByMembers: mock(),
      findByMember: mock(),
      create: mock(),
      update: mock(),
      delete: mock(),
    };
    mockMemberRepo = {
      findMember: mock(),
      findByRoom: mock(),
      add: mock(),
      update: mock(),
      remove: mock(),
      resolveMentions: mock(),
    };
    avatarStore = {
      saveAvatarUpload: mock(),
      removeManagedAvatar: mock(),
    };
    readOnlineAmong.mockReset();
    readOnlineAmong.mockResolvedValue(new Set<string>());
    roomService = makeRoomService(
      mockRepo, mockMemberRepo, undefined, undefined, undefined, undefined, undefined, avatarStore,
      undefined, undefined, readOnlineAmong,
    );
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
    expect(result as any).toEqual([room]);
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
      isBlocked: mock().mockResolvedValue(false),
      areFriends: mock().mockResolvedValue(true),
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
      isBlocked: mock().mockResolvedValue(false),
      areFriends: mock().mockResolvedValue(true),
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
      isBlocked: mock().mockResolvedValue(false),
      areFriends: mock().mockResolvedValue(false),
    };
    roomService = makeRoomService(mockRepo, mockMemberRepo, undefined, socialRepo);

    await expect(roomService.createPrivate('user-1', 'user-2')).rejects.toThrow(ForbiddenError);
    expect(mockRepo.create).not.toHaveBeenCalled();
  });

  it('createPrivate deletes the room when a racing block closes it mid-create', async () => {
    const socialRepo = {
      isBlocked: mock().mockResolvedValue(false),
      areFriends: mock().mockResolvedValue(true),
    };
    const created = { ...room, roomId: 'room-new', type: 'private' as const };
    mockRepo.findPrivateRoomByMembers.mockResolvedValue(null);
    mockRepo.create.mockResolvedValue(created as Room);
    mockMemberRepo.findMember.mockResolvedValue(null);
    mockMemberRepo.add.mockResolvedValue(ownerMember);
    // The block landed between the isBlocked check and the second membership
    // insert; the insert trigger closed the room.
    mockRepo.findById.mockResolvedValue({ ...created, isReadonly: true } as Room);
    roomService = makeRoomService(mockRepo, mockMemberRepo, undefined, socialRepo);

    await expect(roomService.createPrivate('user-1', 'user-2')).rejects.toThrow(ForbiddenError);

    // Both the create and the two adds are already committed, so the rejection
    // has to take the room with it — otherwise a later unblock reopens a room
    // whose creation failed.
    expect(mockRepo.delete).toHaveBeenCalledWith('room-new');
  });

  it('createPrivate still reports the rejection when the cleanup delete fails', async () => {
    const socialRepo = {
      isBlocked: mock().mockResolvedValue(false),
      areFriends: mock().mockResolvedValue(true),
    };
    const created = { ...room, roomId: 'room-new', type: 'private' as const };
    mockRepo.findPrivateRoomByMembers.mockResolvedValue(null);
    mockRepo.create.mockResolvedValue(created as Room);
    mockMemberRepo.findMember.mockResolvedValue(null);
    mockMemberRepo.add.mockResolvedValue(ownerMember);
    mockRepo.findById.mockResolvedValue({ ...created, isReadonly: true } as Room);
    mockRepo.delete.mockRejectedValue(new Error('delete failed'));
    roomService = makeRoomService(mockRepo, mockMemberRepo, undefined, socialRepo);

    // The caller must learn why the request was refused, not how the cleanup went.
    await expect(roomService.createPrivate('user-1', 'user-2')).rejects.toThrow(ForbiddenError);
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
  describe('previewByCode', () => {
    it('returns a preview without joining', async () => {
      mockRepo.findByInviteCode.mockResolvedValue(room);
      mockMemberRepo.findMember.mockResolvedValue(null);

      const preview = await roomService.previewByCode('user-2', 'ABCDEF');

      expect(preview).toEqual({
        roomId: 'room-1',
        name: 'Study Room',
        avatarUrl: undefined,
        requireApproval: false,
        isMember: false,
        isPending: false,
      });
      expect(mockMemberRepo.add).not.toHaveBeenCalled();
    });

    it('flags isMember when the caller already belongs to the room', async () => {
      mockRepo.findByInviteCode.mockResolvedValue(room);
      mockMemberRepo.findMember.mockResolvedValue(ownerMember);

      const preview = await roomService.previewByCode('user-1', 'ABCDEF');

      expect(preview.isMember).toBe(true);
      expect(preview.isPending).toBe(false);
    });

    it('flags isPending when the caller is still awaiting approval', async () => {
      mockRepo.findByInviteCode.mockResolvedValue({ ...room, requireApproval: true });
      mockMemberRepo.findMember.mockResolvedValue({ ...ownerMember, userId: 'user-2', role: 'pending' });

      const preview = await roomService.previewByCode('user-2', 'ABCDEF');

      expect(preview.isMember).toBe(true);
      expect(preview.isPending).toBe(true);
    });

    it('throws NotFoundError for an unknown invite code', async () => {
      mockRepo.findByInviteCode.mockResolvedValue(null);
      await expect(roomService.previewByCode('user-2', 'BOGUS')).rejects.toThrow(NotFoundError);
    });

    it('throws NotFoundError if the invite code somehow resolves to a non-group room', async () => {
      mockRepo.findByInviteCode.mockResolvedValue({ ...room, type: 'private' });
      await expect(roomService.previewByCode('user-2', 'ABCDEF')).rejects.toThrow(NotFoundError);
    });
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

    it('converts a concurrent-insert unique violation into ConflictError', async () => {
      mockRepo.findByInviteCode.mockResolvedValue(room);
      mockMemberRepo.findMember.mockResolvedValue(null);
      mockMemberRepo.add.mockRejectedValue(Object.assign(new Error('duplicate key'), { code: '23505' }));

      await expect(roomService.joinByCode('user-2', 'ABCDEF')).rejects.toThrow(ConflictError);
    });

    it('rethrows non-unique-violation database errors', async () => {
      mockRepo.findByInviteCode.mockResolvedValue(room);
      mockMemberRepo.findMember.mockResolvedValue(null);
      mockMemberRepo.add.mockRejectedValue(Object.assign(new Error('connection lost'), { code: '08006' }));

      await expect(roomService.joinByCode('user-2', 'ABCDEF')).rejects.toThrow('connection lost');
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

    it('revokes the subscription before the membership row is deleted', async () => {
      const order: string[] = [];
      const onMembershipRevoked = mock(async () => { order.push('revoke'); });
      const serviceWithHooks = makeRoomService(
        mockRepo, mockMemberRepo, undefined, undefined, undefined, undefined, mock(), avatarStore,
        onMembershipRevoked, mock(),
      );
      mockRepo.findById.mockResolvedValue(room);
      mockMemberRepo.findMember.mockResolvedValue({ role: 'member' } as RoomMember);
      mockMemberRepo.remove.mockImplementation(async () => { order.push('remove'); });

      await serviceWithHooks.leave('user-2', 'room-1');

      // Reversed, a peer's message committed in between is published to a socket
      // that is still in the room but no longer a member.
      expect(order).toEqual(['revoke', 'remove']);
    });

    it('restores the subscription and signals recovery when the delete fails', async () => {
      const emitToUser = mock();
      const onMembershipGranted = mock();
      const serviceWithHooks = makeRoomService(
        mockRepo, mockMemberRepo, undefined, undefined, undefined, undefined, emitToUser, avatarStore,
        mock(), onMembershipGranted,
      );
      mockRepo.findById.mockResolvedValue(room);
      mockMemberRepo.findMember.mockResolvedValue({ role: 'member' } as RoomMember);
      mockMemberRepo.remove.mockRejectedValue(new Error('remove failed'));

      await expect(serviceWithHooks.leave('user-2', 'room-1')).rejects.toThrow('remove failed');

      expect(onMembershipGranted).toHaveBeenCalledWith('user-2', 'room-1');
      expect(emitToUser).toHaveBeenCalledWith('user-2', 'realtime_ready', undefined);
    });
  });

  describe('kickMember', () => {
    it('allows owner to kick member', async () => {
      mockRepo.findById.mockResolvedValue(room);
      mockMemberRepo.findMember.mockImplementation(async (roomId: string, userId: string) => {
        if (userId === 'user-1') return ownerMember;
        if (userId === 'user-2') return { role: 'member' } as RoomMember;
        return null;
      });
      await roomService.kickMember('room-1', 'user-1', 'user-2');
      expect(mockMemberRepo.remove).toHaveBeenCalledWith('room-1', 'user-2');
    });
    it('prevents kicking the owner', async () => {
      mockRepo.findById.mockResolvedValue(room);
      mockMemberRepo.findMember.mockImplementation(async (roomId: string, userId: string) => {
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
        findById: mock().mockResolvedValue({ userId: 'user-2', name: 'Bob' }),
      };
      mockMessageRepo = {
        create: mock().mockResolvedValue({ messageId: 'msg-sys', content: '[System] Bob已加入' }),
      };
      mockEmit = mock();
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
      mockMemberRepo.findMember.mockImplementation(async (roomId: string, userId: string) => {
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

      avatarStore.saveAvatarUpload.mockResolvedValue('/uploads/avatars/new-avatar.png');
    });

    it('updates room avatar successfully by owner', async () => {
      mockRepo.findById.mockResolvedValue(room);
      mockMemberRepo.findMember.mockResolvedValue(ownerMember);
      
      const updatedRoom = { ...room, avatarUrl: '/uploads/avatars/new-avatar.png' };
      mockRepo.update.mockResolvedValue(updatedRoom);

      const result = await roomService.uploadAvatar('room-1', 'user-1', mockFile);

      expect(mockRepo.findById).toHaveBeenCalledWith('room-1');
      expect(mockMemberRepo.findMember).toHaveBeenCalledWith('room-1', 'user-1');
      expect(avatarStore.saveAvatarUpload).toHaveBeenCalledWith('room-1', mockFile);
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
      expect(avatarStore.removeManagedAvatar).toHaveBeenCalledWith('/uploads/avatars/new-avatar.png');
    });

    it('deletes old avatar after successful update', async () => {
      const roomWithOldAvatar = { ...room, avatarUrl: '/uploads/avatars/old-avatar.png' };
      mockRepo.findById.mockResolvedValue(roomWithOldAvatar);
      mockMemberRepo.findMember.mockResolvedValue(ownerMember);

      const updatedRoom = { ...room, avatarUrl: '/uploads/avatars/new-avatar.png' };
      mockRepo.update.mockResolvedValue(updatedRoom);

      await roomService.uploadAvatar('room-1', 'user-1', mockFile);

      expect(avatarStore.removeManagedAvatar).toHaveBeenCalledWith('/uploads/avatars/old-avatar.png');
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

    it('reports the other member online when any instance holds a lease on them', async () => {
      const privateRoom = { ...room, type: 'private' as const, otherMemberId: 'user-2' };
      mockRepo.findByMember.mockResolvedValue([privateRoom] as any);
      readOnlineAmong.mockResolvedValue(new Set(['user-2']));

      const result = await roomService.list('user-1');

      expect((result[0] as any).isOnline).toBe(true);
    });

    it('asks about the whole page once instead of once per room', async () => {
      mockRepo.findByMember.mockResolvedValue([
        { ...room, roomId: 'r1', type: 'private' as const, otherMemberId: 'user-2' },
        { ...room, roomId: 'r2', type: 'private' as const, otherMemberId: 'user-3' },
        { ...room, roomId: 'r3', type: 'group' as const },
      ] as any);

      await roomService.list('user-1');

      expect(readOnlineAmong).toHaveBeenCalledTimes(1);
      expect(readOnlineAmong).toHaveBeenCalledWith(['user-2', 'user-3']);
    });
  });

  describe('createPrivate (new room path)', () => {
    it('creates a new private room and adds both members when none exists', async () => {
      const socialRepo = {
        isBlocked: mock().mockResolvedValue(false),
        areFriends: mock().mockResolvedValue(true),
      };
      const serviceWithSocial = makeRoomService(mockRepo, mockMemberRepo, undefined, socialRepo);
      const newRoom = { ...room, type: 'private' as const };
      mockRepo.findPrivateRoomByMembers.mockResolvedValue(null);
      mockRepo.create.mockResolvedValue(newRoom);
      mockRepo.findById.mockResolvedValue(newRoom);
      mockMemberRepo.findMember.mockResolvedValue(null);

      const result = await serviceWithSocial.createPrivate('user-1', 'user-2');

      expect(mockRepo.create).toHaveBeenCalled();
      expect(mockMemberRepo.add).toHaveBeenCalledWith({ roomId: newRoom.roomId, userId: 'user-1', role: 'member' });
      expect(mockMemberRepo.add).toHaveBeenCalledWith({ roomId: newRoom.roomId, userId: 'user-2', role: 'member' });
      expect(result).toEqual({ room: newRoom, created: true });
    });

    it('skips add in ensureMember when member already exists', async () => {
      const socialRepo = {
        isBlocked: mock().mockResolvedValue(false),
        areFriends: mock().mockResolvedValue(true),
      };
      const serviceWithSocial = makeRoomService(mockRepo, mockMemberRepo, undefined, socialRepo);
      const newRoom = { ...room, type: 'private' as const };
      mockRepo.findPrivateRoomByMembers.mockResolvedValue(null);
      mockRepo.create.mockResolvedValue(newRoom);
      mockRepo.findById.mockResolvedValue(newRoom);
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
      const emitRoomEvent = mock();
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
      const emitRoomEvent = mock();
      const serviceWithEmit = makeRoomService(mockRepo, mockMemberRepo, emitRoomEvent);
      mockRepo.findById.mockResolvedValue(room);
      mockMemberRepo.findMember.mockResolvedValue({ ...ownerMember, role: 'member' } as RoomMember);

      await serviceWithEmit.leave('user-2', 'room-1');

      expect(emitRoomEvent).toHaveBeenCalledWith('room-1', 'room_update', { type: 'MEMBER_LEFT', data: { userId: 'user-2' } });
    });

    it('creates system message and emits new_message when userRepo and messageRepo are provided', async () => {
      const emitRoomEvent = mock();
      const userRepo = { findById: mock().mockResolvedValue({ userId: 'user-2', name: 'Bob' }) };
      const messageRepo = { create: mock().mockResolvedValue({ messageId: 'msg-1' }) };
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
      const emitRoomEvent = mock();
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
      const emitRoomEvent = mock();
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
      const emitRoomEvent = mock();
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

  describe('updateMember demotion to pending', () => {
    it('revokes the subscription before the role change commits', async () => {
      const order: string[] = [];
      const onMembershipRevoked = mock(async () => { order.push('revoke'); });
      const serviceWithHooks = makeRoomService(
        mockRepo, mockMemberRepo, undefined, undefined, undefined, undefined, mock(), avatarStore,
        onMembershipRevoked, mock(),
      );
      mockRepo.findById.mockResolvedValue(room);
      mockMemberRepo.findMember
        .mockResolvedValueOnce(ownerMember)
        .mockResolvedValueOnce({ ...ownerMember, userId: 'user-2', role: 'member' } as RoomMember);
      mockMemberRepo.update.mockImplementation(async () => {
        order.push('update');
        return ownerMember;
      });

      await serviceWithHooks.updateMember('room-1', 'user-1', 'user-2', { role: 'pending' });

      // Reversed, the demoted member stays in `room_<roomId>` across the commit
      // and a peer's message is delivered to someone who just lost access.
      expect(order).toEqual(['revoke', 'update']);
    });

    it('restores the subscription and signals recovery when the role change fails', async () => {
      const emitToUser = mock();
      const onMembershipRevoked = mock();
      const onMembershipGranted = mock();
      const serviceWithHooks = makeRoomService(
        mockRepo, mockMemberRepo, undefined, undefined, undefined, undefined, emitToUser, avatarStore,
        onMembershipRevoked, onMembershipGranted,
      );
      mockRepo.findById.mockResolvedValue(room);
      mockMemberRepo.findMember
        .mockResolvedValueOnce(ownerMember)
        .mockResolvedValueOnce({ ...ownerMember, userId: 'user-2', role: 'member' } as RoomMember);
      mockMemberRepo.update.mockRejectedValue(new Error('update failed'));

      await expect(
        serviceWithHooks.updateMember('room-1', 'user-1', 'user-2', { role: 'pending' }),
      ).rejects.toThrow('update failed');

      expect(onMembershipRevoked).toHaveBeenCalledWith('user-2', 'room-1');
      expect(onMembershipGranted).toHaveBeenCalledWith('user-2', 'room-1');
      expect(emitToUser).toHaveBeenCalledWith('user-2', 'realtime_ready', undefined);
    });

    it('does not revoke anything for a plain nickname change', async () => {
      const onMembershipRevoked = mock();
      const serviceWithHooks = makeRoomService(
        mockRepo, mockMemberRepo, undefined, undefined, undefined, undefined, mock(), avatarStore,
        onMembershipRevoked, mock(),
      );
      mockRepo.findById.mockResolvedValue(room);
      mockMemberRepo.findMember
        .mockResolvedValueOnce(ownerMember)
        .mockResolvedValueOnce({ ...ownerMember, userId: 'user-2', role: 'member' } as RoomMember);
      mockMemberRepo.update.mockResolvedValue(ownerMember);

      await serviceWithHooks.updateMember('room-1', 'user-1', 'user-2', { nickname: 'Bob' });

      expect(onMembershipRevoked).not.toHaveBeenCalled();
    });
  });

  describe('kickMember with emitRoomEvent and system message', () => {
    it('emits MEMBER_KICKED when emitRoomEvent is provided', async () => {
      const emitRoomEvent = mock();
      const serviceWithEmit = makeRoomService(mockRepo, mockMemberRepo, emitRoomEvent);
      mockRepo.findById.mockResolvedValue(room);
      mockMemberRepo.findMember
        .mockResolvedValueOnce(ownerMember)
        .mockResolvedValueOnce({ ...ownerMember, userId: 'user-2', role: 'member' } as RoomMember);

      await serviceWithEmit.kickMember('room-1', 'user-1', 'user-2');

      expect(emitRoomEvent).toHaveBeenCalledWith('room-1', 'room_update', { type: 'MEMBER_KICKED', data: { userId: 'user-2' } });
    });

    it('creates system message when userRepo and messageRepo are provided', async () => {
      const emitRoomEvent = mock();
      const userRepo = { findById: mock().mockResolvedValue({ userId: 'user-2', name: 'Bob' }) };
      const messageRepo = { create: mock().mockResolvedValue({ messageId: 'msg-1' }) };
      const serviceWithAll = makeRoomService(mockRepo, mockMemberRepo, emitRoomEvent, undefined, userRepo as any, messageRepo as any);
      mockRepo.findById.mockResolvedValue(room);
      mockMemberRepo.findMember
        .mockResolvedValueOnce(ownerMember)
        .mockResolvedValueOnce({ ...ownerMember, userId: 'user-2', role: 'member' } as RoomMember);

      await serviceWithAll.kickMember('room-1', 'user-1', 'user-2');

      expect(messageRepo.create).toHaveBeenCalledWith(expect.objectContaining({ content: '[System] Bob已被移出群組' }));
    });

    it('restores the subscription and signals recovery when the conditional delete loses the race', async () => {
      const emitToUser = mock();
      const onMembershipRevoked = mock();
      const onMembershipGranted = mock();
      const serviceWithHooks = makeRoomService(
        mockRepo, mockMemberRepo, undefined, undefined, undefined, undefined, emitToUser, avatarStore,
        onMembershipRevoked, onMembershipGranted,
      );
      mockRepo.findById.mockResolvedValue(room);
      mockMemberRepo.findMember
        .mockResolvedValueOnce(ownerMember)
        .mockResolvedValueOnce({ ...ownerMember, userId: 'user-2', role: 'member' } as RoomMember);
      // The target was promoted between the role check and the delete.
      mockMemberRepo.removeIfAuthorized = mock().mockResolvedValue(false);

      await expect(serviceWithHooks.kickMember('room-1', 'user-1', 'user-2')).rejects.toThrow(ConflictError);

      expect(mockMemberRepo.remove).not.toHaveBeenCalled();
      expect(onMembershipRevoked).toHaveBeenCalledWith('user-2', 'room-1');
      expect(onMembershipGranted).toHaveBeenCalledWith('user-2', 'room-1');
      // Rejoining a Socket.IO room replays nothing, so the target has to be
      // told to run `/sync` for the changes published while it was out.
      expect(emitToUser).toHaveBeenCalledWith('user-2', 'realtime_ready', undefined);
    });

    it('does not signal recovery when the kick succeeds', async () => {
      const emitToUser = mock();
      const serviceWithHooks = makeRoomService(
        mockRepo, mockMemberRepo, undefined, undefined, undefined, undefined, emitToUser, avatarStore,
        mock(), mock(),
      );
      mockRepo.findById.mockResolvedValue(room);
      mockMemberRepo.findMember
        .mockResolvedValueOnce(ownerMember)
        .mockResolvedValueOnce({ ...ownerMember, userId: 'user-2', role: 'member' } as RoomMember);
      mockMemberRepo.removeIfAuthorized = mock().mockResolvedValue(true);

      await serviceWithHooks.kickMember('room-1', 'user-1', 'user-2');

      expect(emitToUser).not.toHaveBeenCalledWith('user-2', 'realtime_ready', undefined);
    });
  });

  describe('uploadAvatar with emitRoomEvent', () => {
    it('emits ROOM_AVATAR_UPDATED event when emitRoomEvent is provided', async () => {
      const emitRoomEvent = mock();
      const serviceWithEmit = makeRoomService(
        mockRepo, mockMemberRepo, emitRoomEvent, undefined, undefined, undefined, undefined, avatarStore,
      );
      avatarStore.saveAvatarUpload.mockResolvedValue('/uploads/avatars/new.png');
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
        isBlocked: mock().mockResolvedValue(true),
        areFriends: mock().mockResolvedValue(true),
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
