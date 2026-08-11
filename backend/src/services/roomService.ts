import type { UploadedFile } from '../utils/fileUpload';
import type { Room, RoomInvitePreview, RoomSummary } from '@shared/types';
import { randomBytes } from 'crypto';
import { isUserOnline } from '../realtime/presence';
import { defaultAvatarStore, type AvatarStore } from '../utils/avatarUpload';
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

export const makeRoomService = (
  repo: IRoomRepository,
  roomMemberRepo: IRoomMemberRepository,
  emitRoomEvent?: (roomId: string, eventName: string, payload: unknown) => void,
  socialRepo?: {
    isBlocked(userA: string, userB: string): Promise<boolean>;
    areFriends(userA: string, userB: string): Promise<boolean>;
    withUserPairLock?<T>(userA: string, userB: string, operation: () => Promise<T>): Promise<T>;
  },
  userRepo?: IUserRepository,
  messageRepo?: IMessageRepository,
  // Emits an event directly to a specific user's personal socket room (user_${userId}).
  // Used to notify users of events they cannot receive via room broadcast (e.g., being
  // approved into a group they haven't joined yet).
  emitToUser?: (userId: string, eventName: string, payload: unknown) => void,
  avatarStore: AvatarStore = defaultAvatarStore,
  onMembershipRevoked?: (userId: string, roomId: string) => void | Promise<void>,
  onMembershipGranted?: (userId: string, roomId: string) => void | Promise<void>,
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
      await onMembershipGranted?.(creatorId, room.roomId);
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
            isOnline: isUserOnline(room.otherMemberId),
          };
        }
        return room;
      });
    },

    async createPrivate(creatorId: string, targetUserId: string, bypassFriendCheck = false): Promise<{ room: Room; created: boolean }> {
      if (creatorId === targetUserId) {
        throw new ValidationError('Cannot create a private room with yourself');
      }
      const openPrivateRoom = async (): Promise<{ room: Room; created: boolean }> => {
        if (!socialRepo) {
          if (!bypassFriendCheck) throw new ForbiddenError('Private rooms require friendship validation');
        } else {
          if (await socialRepo.isBlocked(creatorId, targetUserId)) {
            throw new ForbiddenError('Cannot create a private room with a blocked user');
          }
          if (!bypassFriendCheck && !(await socialRepo.areFriends(creatorId, targetUserId))) {
            throw new ForbiddenError('Private rooms require an accepted friendship');
          }
        }

        const existing = await repo.findPrivateRoomByMembers(creatorId, targetUserId);
        if (existing) {
          if (existing.isReadonly) {
            const room = repo.reopenPrivateRoomIfUnblocked
              ? await repo.reopenPrivateRoomIfUnblocked(existing.roomId, creatorId, targetUserId)
              : await repo.update(existing.roomId, { isReadonly: false });
            if (!room) throw new ForbiddenError('Cannot reopen a blocked private room');
            await onMembershipGranted?.(creatorId, existing.roomId);
            await onMembershipGranted?.(targetUserId, existing.roomId);
            if (emitToUser) {
              emitToUser(creatorId, 'room_update', { type: 'ROOM_JOINED', roomId: existing.roomId, data: {} });
              emitToUser(targetUserId, 'room_update', { type: 'ROOM_JOINED', roomId: existing.roomId, data: {} });
            }
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
        const canonicalRoom = await repo.findById(room.roomId);
        if (!canonicalRoom || canonicalRoom.isReadonly) {
          throw new ForbiddenError('Cannot create a private room with a blocked user');
        }
        await onMembershipGranted?.(creatorId, room.roomId);
        await onMembershipGranted?.(targetUserId, room.roomId);
        if (emitToUser) {
          emitToUser(creatorId, 'room_update', { type: 'ROOM_JOINED', roomId: room.roomId, data: {} });
          emitToUser(targetUserId, 'room_update', { type: 'ROOM_JOINED', roomId: room.roomId, data: {} });
        }
        return { room: canonicalRoom, created: true };
      };

      if (socialRepo?.withUserPairLock) {
        return socialRepo.withUserPairLock(creatorId, targetUserId, openPrivateRoom);
      }
      return openPrivateRoom();
    },

    async markPrivateReadOnly(userA: string, userB: string): Promise<string | null> {
      const existing = await repo.findPrivateRoomByMembers(userA, userB);
      if (existing) {
        await repo.update(existing.roomId, { isReadonly: true });
        return existing.roomId;
      }
      return null;
    },

    /**
     * Used by the block flow to locate the room whose sockets need revoking.
     * It deliberately does not touch room state: the `blocks` insert trigger
     * already closes the room inside the same transaction as the block row,
     * and a second writer for that invariant is what let a concurrent unblock
     * leave a room read-only with no block to undo it. Returning null when the
     * block is gone also stops a stale request from revoking access to a room
     * that has legitimately reopened.
     */
    async findPrivateRoomIdIfBlocked(userA: string, userB: string): Promise<string | null> {
      if (repo.findPrivateRoomIdIfBlocked) {
        return repo.findPrivateRoomIdIfBlocked(userA, userB);
      }
      const existing = await repo.findPrivateRoomByMembers(userA, userB);
      return existing ? existing.roomId : null;
    },

    async reopenPrivateRoom(userA: string, userB: string): Promise<void> {
      const existing = await repo.findPrivateRoomByMembers(userA, userB);
      if (existing && existing.isReadonly) {
        const reopened = repo.reopenPrivateRoomIfUnblocked
          ? await repo.reopenPrivateRoomIfUnblocked(existing.roomId, userA, userB)
          : await repo.update(existing.roomId, { isReadonly: false });
        if (!reopened) return;
        await onMembershipGranted?.(userA, existing.roomId);
        await onMembershipGranted?.(userB, existing.roomId);
        if (emitToUser) {
          emitToUser(userA, 'room_update', { type: 'ROOM_JOINED', roomId: existing.roomId, data: {} });
          emitToUser(userB, 'room_update', { type: 'ROOM_JOINED', roomId: existing.roomId, data: {} });
        }
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
      if (emitRoomEvent) {
        emitRoomEvent(roomId, 'room_update', { type: 'ROOM_SETTINGS_UPDATED', data: updated });
      }
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
        await onMembershipGranted?.(userId, room.roomId);
        // Notify existing room members that someone new joined.
        if (emitRoomEvent) {
          emitRoomEvent(room.roomId, 'room_update', { type: 'MEMBER_JOINED', data: { userId } });
        }
        // Notify the joining user directly so their room list refreshes immediately.
        // They are not yet in the socket room, so the room broadcast above won't reach them.
        if (emitToUser) {
          emitToUser(userId, 'room_update', { type: 'ROOM_JOINED', roomId: room.roomId, data: {} });
        }
        if (userRepo && messageRepo) {
          const user = await userRepo.findById(userId);
          if (user) {
            const sysMsg = await messageRepo.create({
              roomId: room.roomId,
              senderId: null,
              content: `[System] ${user.name}已加入`,
            });
            if (emitRoomEvent) {
              emitRoomEvent(room.roomId, 'new_message', sysMsg);
            }
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
      await onMembershipRevoked?.(userId, roomId);
      emitToUser?.(userId, 'room_update', {
        type: 'MEMBER_LEFT',
        roomId,
        data: { userId },
      });

      if (emitRoomEvent) {
        emitRoomEvent(roomId, 'room_update', { type: 'MEMBER_LEFT', data: { userId } });
      }

      if (userRepo && messageRepo) {
        const user = await userRepo.findById(userId);
        if (user) {
          const sysMsg = await messageRepo.create({
            roomId,
            senderId: null,
            content: `[System] ${user.name}已離開`,
          });
          if (emitRoomEvent) {
            emitRoomEvent(roomId, 'new_message', sysMsg);
          }
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

      if (repo.transferOwnership) {
        await repo.transferOwnership(roomId, callerId, targetUserId);
      } else {
        // Kept for lightweight service doubles; the production repository
        // always uses the transaction above.
        await roomMemberRepo.update(roomId, callerId, { role: 'admin' });
        await roomMemberRepo.update(roomId, targetUserId, { role: 'owner' });
      }

      if (emitRoomEvent) {
        emitRoomEvent(roomId, 'room_update', { type: 'OWNERSHIP_TRANSFERRED', data: { oldOwner: callerId, newOwner: targetUserId } });
      }
    },

    async deleteGroup(roomId: string, callerId: string): Promise<void> {
      const existing = await repo.findById(roomId);
      if (!existing) throw new NotFoundError('room', roomId);
      if (existing.type !== 'group') throw new ValidationError('Cannot delete a private room');

      const caller = await roomMemberRepo.findMember(roomId, callerId);
      if (!caller || caller.role !== 'owner') {
        throw new ForbiddenError('Only the owner can delete the group');
      }

      const members = (await roomMemberRepo.findByRoom(roomId)) ?? [];
      await repo.delete(roomId);
      for (const member of members) {
        emitToUser?.(member.userId, 'room_update', {
          type: 'ROOM_DELETED',
          roomId,
          data: { roomId },
        });
        await onMembershipRevoked?.(member.userId, roomId);
      }
      if (emitRoomEvent) {
        emitRoomEvent(roomId, 'room_update', { type: 'ROOM_DELETED', data: { roomId } });
      }
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
      await onMembershipGranted?.(targetUserId, roomId);
      if (emitRoomEvent) {
        emitRoomEvent(roomId, 'room_update', { type: 'MEMBER_APPROVED', data: { userId: targetUserId } });
      }
      // Notify the approved user directly — they are not yet subscribed to the
      // room's socket channel, so the room broadcast above won't reach them.
      if (emitToUser) {
        emitToUser(targetUserId, 'room_update', { type: 'ROOM_JOINED', roomId, data: {} });
      }

      if (userRepo && messageRepo) {
        const user = await userRepo.findById(targetUserId);
        if (user) {
          const sysMsg = await messageRepo.create({
            roomId,
            senderId: null,
            content: `[System] ${user.name}已加入`,
          });
          if (emitRoomEvent) {
            emitRoomEvent(roomId, 'new_message', sysMsg);
          }
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
      if (target.role === 'pending' && data.role && data.role !== 'pending') {
        await onMembershipGranted?.(targetUserId, roomId);
      } else if (target.role !== 'pending' && data.role === 'pending') {
        await onMembershipRevoked?.(targetUserId, roomId);
        emitToUser?.(targetUserId, 'room_update', {
          type: 'MEMBER_UPDATED',
          roomId,
          data: { userId: targetUserId, ...data as Record<string, unknown> },
        });
      }
      if (emitRoomEvent) {
        emitRoomEvent(roomId, 'room_update', { type: 'MEMBER_UPDATED', data: { userId: targetUserId, ...data as Record<string, unknown> } });
      }
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

      // Revoke the live subscription before the conditional delete. If the
      // target's role changed after the initial checks, restore the
      // subscription below and report a conflict rather than deleting a new
      // owner/admin.
      await onMembershipRevoked?.(targetUserId, roomId);
      const removed = roomMemberRepo.removeIfAuthorized
        ? await roomMemberRepo.removeIfAuthorized(roomId, callerId, targetUserId, target.role)
        : (await roomMemberRepo.remove(roomId, targetUserId), true);
      if (!removed) {
        await onMembershipGranted?.(targetUserId, roomId);
        // Restoring the subscription does not replay what it missed. Anything
        // published to the room between the revoke above and this restore was
        // broadcast while the target had no session in `room_<roomId>`, and a
        // rejoin delivers nothing retroactively. `realtime_ready` is the
        // client's standing recovery signal — it re-runs `/sync` from its
        // cursor — so the durable changes committed inside that window are
        // recovered instead of being lost for the rest of the session.
        emitToUser?.(targetUserId, 'realtime_ready', undefined);
        throw new ConflictError('Room membership changed; retry the kick');
      }
      emitToUser?.(targetUserId, 'room_update', {
        type: 'MEMBER_KICKED',
        roomId,
        data: { userId: targetUserId },
      });
      if (emitRoomEvent) {
        emitRoomEvent(roomId, 'room_update', { type: 'MEMBER_KICKED', data: { userId: targetUserId } });
      }

      if (userRepo && messageRepo) {
        const user = await userRepo.findById(targetUserId);
        if (user) {
          const sysMsg = await messageRepo.create({
            roomId,
            senderId: null,
            content: `[System] ${user.name}已被移出群組`,
          });
          if (emitRoomEvent) {
            emitRoomEvent(roomId, 'new_message', sysMsg);
          }
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

      const avatarUrl = await avatarStore.saveAvatarUpload(roomId, file);

      try {
        const updated = await repo.update(roomId, { avatarUrl });
        if (room.avatarUrl && room.avatarUrl !== avatarUrl) {
          await avatarStore.removeManagedAvatar(room.avatarUrl);
        }
        if (emitRoomEvent) {
          emitRoomEvent(roomId, 'room_update', { type: 'ROOM_AVATAR_UPDATED', data: { roomId, avatarUrl } });
        }
        return updated;
      } catch (error) {
        await avatarStore.removeManagedAvatar(avatarUrl);
        throw error;
      }
    },
  };
};
