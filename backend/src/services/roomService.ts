import type { UploadedFile } from '../utils/fileUpload';
import type { Room, RoomInvitePreview, RoomSummary } from '@shared/types';
import { randomBytes } from 'crypto';
import { removeManagedAvatar, saveAvatarUpload } from '../utils/avatarUpload';
import type { IRoomRepository } from '../models/IRoomRepository';
import type { IRoomMemberRepository } from '../models/IRoomMemberRepository';
import type { IUserRepository } from '../models/IUserRepository';
import type { IMessageRepository } from '../models/IMessageRepository';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../utils/AppError';
import {
  createRoomSchema,
  updateRoomSchema,
  type CreateRoomInput,
  type UpdateRoomInput,
} from '../routes/roomSchemas';

const validationMessage = (issues: { message: string }[]) =>
  issues[0]?.message ?? 'Invalid room payload';

const generateInviteCode = () => randomBytes(6).toString('base64url').slice(0, 8).toUpperCase();

export interface RoomRealtimeNotifier {
  roomUpdated(roomId: string, change: string, data: unknown): void;
  messageCreated(roomId: string, message: unknown): void;
  userRoomUpdated(userId: string, roomId: string, change: string, data: unknown): void;
}

export const makeRoomService = (
  repo: IRoomRepository,
  roomMemberRepo: IRoomMemberRepository,
  realtime?: RoomRealtimeNotifier,
  socialRepo?: { isBlocked(userA: string, userB: string): Promise<boolean>; areFriends(userA: string, userB: string): Promise<boolean> },
  userRepo?: IUserRepository,
  messageRepo?: IMessageRepository,
  isOnline: (userId: string) => boolean = () => false,
) => {
  const ensureMember = async (roomId: string, userId: string) => {
    const existing = await roomMemberRepo.findMember(roomId, userId);
    if (!existing) {
      await roomMemberRepo.add({ roomId, userId, role: 'member' });
    }
  };

  return {
    async create(creatorId: string, data: CreateRoomInput): Promise<Room> {
      const parsed = createRoomSchema.safeParse(data);
      if (!parsed.success) {
        throw new ValidationError(validationMessage(parsed.error.issues));
      }
      let inviteCode: string | undefined;
      if (parsed.data.type === 'group') {
        do {
          inviteCode = generateInviteCode();
        } while (await repo.findByInviteCode(inviteCode));
      }

      const room = await repo.create({ ...parsed.data, inviteCode });
      await roomMemberRepo.add({ roomId: room.roomId, userId: creatorId, role: 'owner' });
      return room;
    },

    async getById(roomId: string, callerId: string): Promise<Room> {
      const room = await repo.findById(roomId);
      if (!room) throw new NotFoundError('room', roomId);
      const member = await roomMemberRepo.findMember(roomId, callerId);
      if (!member) throw new ForbiddenError('User is not a member of this room');
      return room;
    },

    async list(userId: string): Promise<RoomSummary[]> {
      const rooms = await repo.findByMember(userId);
      return rooms.map((room) => {
        if (room.type === 'private' && room.otherMemberId) {
          return {
            ...room,
            isOnline: isOnline(room.otherMemberId),
          };
        }
        return room;
      });
    },

    async createPrivate(creatorId: string, targetUserId: string, bypassFriendCheck = false): Promise<{ room: Room; created: boolean }> {
      if (creatorId === targetUserId) {
        throw new ValidationError('Cannot create a private room with yourself');
      }
      if (!bypassFriendCheck) {
        if (!socialRepo) {
          throw new ForbiddenError('Private rooms require friendship validation');
        }
        if (await socialRepo.isBlocked(creatorId, targetUserId)) {
          throw new ForbiddenError('Cannot create a private room with a blocked user');
        }
        if (!(await socialRepo.areFriends(creatorId, targetUserId))) {
          throw new ForbiddenError('Private rooms require an accepted friendship');
        }
      }

      const existing = await repo.findPrivateRoomByMembers(creatorId, targetUserId);
      if (existing) {
        if (existing.isReadonly) {
          const room = await repo.update(existing.roomId, { isReadonly: false });
          realtime?.userRoomUpdated(creatorId, existing.roomId, 'ROOM_JOINED', {});
          realtime?.userRoomUpdated(targetUserId, existing.roomId, 'ROOM_JOINED', {});
          return { room, created: false };
        }
        return { room: existing, created: false };
      }

      const room = await repo.create({
        type: 'private',
        name: undefined,
        requireApproval: false,
        viewHistory: true,
      });
      await ensureMember(room.roomId, creatorId);
      await ensureMember(room.roomId, targetUserId);
      realtime?.userRoomUpdated(creatorId, room.roomId, 'ROOM_JOINED', {});
      realtime?.userRoomUpdated(targetUserId, room.roomId, 'ROOM_JOINED', {});
      return { room, created: true };
    },

    async markPrivateReadOnly(userA: string, userB: string): Promise<void> {
      const existing = await repo.findPrivateRoomByMembers(userA, userB);
      if (existing) {
        await repo.update(existing.roomId, { isReadonly: true });
      }
    },

    async reopenPrivateRoom(userA: string, userB: string): Promise<void> {
      const existing = await repo.findPrivateRoomByMembers(userA, userB);
      if (existing && existing.isReadonly) {
        await repo.update(existing.roomId, { isReadonly: false });
        realtime?.userRoomUpdated(userA, existing.roomId, 'ROOM_JOINED', {});
        realtime?.userRoomUpdated(userB, existing.roomId, 'ROOM_JOINED', {});
      }
    },

    async listMembers(roomId: string, callerId: string) {
      const room = await repo.findById(roomId);
      if (!room) throw new NotFoundError('room', roomId);
      const caller = await roomMemberRepo.findMember(roomId, callerId);
      if (!caller) throw new ForbiddenError('User is not a member of this room');
      if (caller.role === 'pending') {
        return [caller];
      }
      return roomMemberRepo.findByRoom(roomId);
    },

    async update(roomId: string, callerId: string, data: UpdateRoomInput): Promise<Room> {
      const parsed = updateRoomSchema.safeParse(data);
      if (!parsed.success) {
        throw new ValidationError(validationMessage(parsed.error.issues));
      }
      const room = await repo.findById(roomId);
      if (!room) throw new NotFoundError('room', roomId);
      const member = await roomMemberRepo.findMember(roomId, callerId);
      if (!member || (member.role !== 'owner' && member.role !== 'admin')) {
        throw new ForbiddenError('Only owner or admin can update room settings');
      }
      const updated = await repo.update(roomId, parsed.data);
      realtime?.roomUpdated(roomId, 'ROOM_SETTINGS_UPDATED', updated);
      return updated;
    },

    async previewByCode(userId: string, inviteCode: string): Promise<RoomInvitePreview> {
      const room = await repo.findByInviteCode(inviteCode);
      if (!room || room.type !== 'group') throw new NotFoundError('room', inviteCode);
      const existing = await roomMemberRepo.findMember(room.roomId, userId);
      return {
        roomId: room.roomId,
        name: room.name,
        avatarUrl: room.avatarUrl,
        requireApproval: room.requireApproval,
        isMember: !!existing,
        isPending: existing?.role === 'pending',
      };
    },

    async joinByCode(userId: string, inviteCode: string): Promise<Room> {
      const room = await repo.findByInviteCode(inviteCode);
      if (!room) throw new NotFoundError('room', inviteCode);
      const existing = await roomMemberRepo.findMember(room.roomId, userId);
      if (existing) throw new ConflictError('User is already a member of this room');
      const role = room.requireApproval ? 'pending' : 'member';
      try {
        await roomMemberRepo.add({ roomId: room.roomId, userId, role });
      } catch (err) {
        // Two simultaneous joins can both pass the findMember check above; the
        // losing insert then violates the (room_id, user_id) primary key. Report
        // it as the same conflict the pre-check would have raised rather than a 500.
        if ((err as { code?: string }).code === '23505') {
          throw new ConflictError('User is already a member of this room');
        }
        throw err;
      }

      if (role === 'member') {
        // Notify existing room members that someone new joined.
        realtime?.roomUpdated(room.roomId, 'MEMBER_JOINED', { userId });
        // Notify the joining user directly so their room list refreshes immediately.
        // They are not yet in the socket room, so the room broadcast above won't reach them.
        realtime?.userRoomUpdated(userId, room.roomId, 'ROOM_JOINED', {});
        if (userRepo && messageRepo) {
          const user = await userRepo.findById(userId);
          if (user) {
            const sysMsg = await messageRepo.create({
              roomId: room.roomId,
              senderId: null,
              content: `[System] ${user.name}已加入`,
            });
            realtime?.messageCreated(room.roomId, sysMsg);
          }
        }
      }

      return room;
    },

    async leave(userId: string, roomId: string): Promise<void> {
      const room = await repo.findById(roomId);
      if (!room) throw new NotFoundError('room', roomId);
      const member = await roomMemberRepo.findMember(roomId, userId);
      if (!member) throw new ForbiddenError('User is not a member of this room');
      if (member.role === 'owner') {
        throw new ForbiddenError('Owner cannot leave room. Transfer ownership first.');
      }
      await roomMemberRepo.remove(roomId, userId);

      realtime?.roomUpdated(roomId, 'MEMBER_LEFT', { userId });

      if (userRepo && messageRepo) {
        const user = await userRepo.findById(userId);
        if (user) {
          const sysMsg = await messageRepo.create({
            roomId,
            senderId: null,
            content: `[System] ${user.name}已離開`,
          });
          realtime?.messageCreated(roomId, sysMsg);
        }
      }
    },

    async transferOwnership(roomId: string, callerId: string, targetUserId: string): Promise<void> {
      const room = await repo.findById(roomId);
      if (!room) throw new NotFoundError('room', roomId);
      if (room.type !== 'group') throw new ValidationError('Cannot transfer ownership of a private room');

      const caller = await roomMemberRepo.findMember(roomId, callerId);
      if (!caller || caller.role !== 'owner') {
        throw new ForbiddenError('Only the owner can transfer ownership');
      }

      const target = await roomMemberRepo.findMember(roomId, targetUserId);
      if (!target) throw new NotFoundError('member', targetUserId);
      if (target.role === 'pending') {
        throw new ValidationError('Cannot transfer ownership to a pending member');
      }

      await roomMemberRepo.update(roomId, callerId, { role: 'admin' });
      await roomMemberRepo.update(roomId, targetUserId, { role: 'owner' });

      realtime?.roomUpdated(roomId, 'OWNERSHIP_TRANSFERRED', { oldOwner: callerId, newOwner: targetUserId });
    },

    async deleteGroup(roomId: string, callerId: string): Promise<void> {
      const existing = await repo.findById(roomId);
      if (!existing) throw new NotFoundError('room', roomId);
      if (existing.type !== 'group') throw new ValidationError('Cannot delete a private room');

      const caller = await roomMemberRepo.findMember(roomId, callerId);
      if (!caller || caller.role !== 'owner') {
        throw new ForbiddenError('Only the owner can delete the group');
      }

      await repo.delete(roomId);
      realtime?.roomUpdated(roomId, 'ROOM_DELETED', { roomId });
    },

    async approveMember(roomId: string, callerId: string, targetUserId: string): Promise<void> {
      const room = await repo.findById(roomId);
      if (!room) throw new NotFoundError('room', roomId);
      if (!room.requireApproval) throw new ValidationError('Room does not require approval');
      const caller = await roomMemberRepo.findMember(roomId, callerId);
      if (!caller || (caller.role !== 'owner' && caller.role !== 'admin')) {
        throw new ForbiddenError('Only owner or admin can approve members');
      }
      const target = await roomMemberRepo.findMember(roomId, targetUserId);
      if (!target) throw new NotFoundError('member', targetUserId);
      if (target.role !== 'pending') throw new ValidationError('Member is not pending approval');

      await roomMemberRepo.update(roomId, targetUserId, { role: 'member' });
      realtime?.roomUpdated(roomId, 'MEMBER_APPROVED', { userId: targetUserId });
      // Notify the approved user directly — they are not yet subscribed to the
      // room's socket channel, so the room broadcast above won't reach them.
      realtime?.userRoomUpdated(targetUserId, roomId, 'ROOM_JOINED', {});

      if (userRepo && messageRepo) {
        const user = await userRepo.findById(targetUserId);
        if (user) {
          const sysMsg = await messageRepo.create({
            roomId,
            senderId: null,
            content: `[System] ${user.name}已加入`,
          });
          realtime?.messageCreated(roomId, sysMsg);
        }
      }
    },

    async updateMember(roomId: string, callerId: string, targetUserId: string, data: { role?: string; nickname?: string; isMuted?: boolean }): Promise<void> {
      const room = await repo.findById(roomId);
      if (!room) throw new NotFoundError('room', roomId);
      const caller = await roomMemberRepo.findMember(roomId, callerId);
      if (!caller) throw new ForbiddenError('Not a member');
      
      const target = await roomMemberRepo.findMember(roomId, targetUserId);
      if (!target) throw new NotFoundError('member', targetUserId);

      if (callerId !== targetUserId) {
        if (caller.role !== 'owner' && caller.role !== 'admin') {
          throw new ForbiddenError('Only owner or admin can update other members');
        }
        if (caller.role === 'admin' && (target.role === 'owner' || target.role === 'admin')) {
          throw new ForbiddenError('Admin cannot update owner or other admins');
        }
        if (data.role && caller.role !== 'owner') {
          throw new ForbiddenError('Only owner can change roles');
        }
      } else {
        if (data.role || data.isMuted !== undefined) {
          throw new ForbiddenError('Cannot update your own role or mute status');
        }
      }

      await roomMemberRepo.update(roomId, targetUserId, data as Parameters<typeof roomMemberRepo.update>[2]);
      realtime?.roomUpdated(roomId, 'MEMBER_UPDATED', { userId: targetUserId, ...data as Record<string, unknown> });
    },

    async kickMember(roomId: string, callerId: string, targetUserId: string): Promise<void> {
      const room = await repo.findById(roomId);
      if (!room) throw new NotFoundError('room', roomId);
      
      const caller = await roomMemberRepo.findMember(roomId, callerId);
      if (!caller || (caller.role !== 'owner' && caller.role !== 'admin')) {
        throw new ForbiddenError('Only owner or admin can kick members');
      }
      
      const target = await roomMemberRepo.findMember(roomId, targetUserId);
      if (!target) throw new NotFoundError('member', targetUserId);
      
      if (caller.role === 'admin' && (target.role === 'owner' || target.role === 'admin')) {
        throw new ForbiddenError('Admin cannot kick owner or other admins');
      }
      if (target.role === 'owner') {
        throw new ForbiddenError('Owner cannot be kicked');
      }

      await roomMemberRepo.remove(roomId, targetUserId);
      realtime?.roomUpdated(roomId, 'MEMBER_KICKED', { userId: targetUserId });

      if (userRepo && messageRepo) {
        const user = await userRepo.findById(targetUserId);
        if (user) {
          const sysMsg = await messageRepo.create({
            roomId,
            senderId: null,
            content: `[System] ${user.name}已被移出群組`,
          });
          realtime?.messageCreated(roomId, sysMsg);
        }
      }
    },

    async uploadAvatar(roomId: string, callerId: string, file: UploadedFile): Promise<Room> {
      const room = await repo.findById(roomId);
      if (!room) throw new NotFoundError('room', roomId);
      if (room.type !== 'group') throw new ValidationError('Cannot upload avatar for a private room');

      const member = await roomMemberRepo.findMember(roomId, callerId);
      if (!member || (member.role !== 'owner' && member.role !== 'admin')) {
        throw new ForbiddenError('Only owner or admin can update room avatar');
      }

      const avatarUrl = await saveAvatarUpload(roomId, file);

      try {
        const updated = await repo.update(roomId, { avatarUrl });
        if (room.avatarUrl && room.avatarUrl !== avatarUrl) {
          await removeManagedAvatar(room.avatarUrl);
        }
        realtime?.roomUpdated(roomId, 'ROOM_AVATAR_UPDATED', { roomId, avatarUrl });
        return updated;
      } catch (error) {
        await removeManagedAvatar(avatarUrl);
        throw error;
      }
    },
  };
};
