import { AppError, ConflictError, ValidationError } from '../utils/AppError';
import type { makeFriendRepository } from '../models/friendRepository';

export function makeFriendService(
  repo: ReturnType<typeof makeFriendRepository>,
  notifyUser?: (userId: string, payload: unknown) => void,
  privateRooms?: {
    markPrivateReadOnly(userA: string, userB: string): Promise<void>;
    createPrivate?(userA: string, userB: string): Promise<unknown>;
    reopenPrivateRoom?(userA: string, userB: string): Promise<void>;
  },
  isOnline: (userId: string) => boolean = () => false,
) {
  return {
    async sendFriendRequest(requesterId: string, targetUserId: string) {
      if (requesterId === targetUserId) {
        throw new ValidationError('Cannot send friend request to yourself');
      }

      const isBlocked = await repo.isBlocked(requesterId, targetUserId);
      if (isBlocked) {
        throw new AppError(403, 'Cannot interact with this user', 'FORBIDDEN');
      }

      const areFriends = await repo.areFriends(requesterId, targetUserId);
      if (areFriends) {
        throw new ValidationError('Already friends');
      }

      const pendingForMe = await repo.getPendingRequests(requesterId);
      const reciprocal = pendingForMe.find(req => req.requesterId === targetUserId);
      if (reciprocal) {
        const accepted = await repo.acceptFriendRequest(targetUserId, requesterId);
        if (notifyUser) {
          notifyUser(targetUserId, accepted);
        }
        if (privateRooms?.reopenPrivateRoom) {
          await privateRooms.reopenPrivateRoom(requesterId, targetUserId);
        }
        return accepted;
      }

      let request;
      try {
        request = await repo.sendFriendRequest(requesterId, targetUserId);
      } catch (err: unknown) {
        const pgErr = err as { code?: string; message?: string };
        if (pgErr?.code === '23505' || (typeof pgErr?.message === 'string' && (pgErr.message.includes('23505') || pgErr.message.includes('duplicate key')))) {
          throw new ConflictError('Friend request already sent');
        }
        throw err;
      }
      
      if (notifyUser) {
        notifyUser(targetUserId, request);
      }
      return request;
    },

    async getPendingRequests(userId: string) {
      return repo.getPendingRequests(userId);
    },

    async respondFriendRequest(userId: string, requesterId: string, status: 'accepted' | 'rejected') {
      if (status === 'accepted') {
        const isBlocked = await repo.isBlocked(requesterId, userId);
        if (isBlocked) {
          throw new AppError(403, 'Cannot interact with this user', 'FORBIDDEN');
        }
        const accepted = await repo.acceptFriendRequest(requesterId, userId);
        if (!accepted) {
          throw new AppError(404, 'Friend request not found', 'NOT_FOUND');
        }
        if (privateRooms?.reopenPrivateRoom) {
          await privateRooms.reopenPrivateRoom(requesterId, userId);
        }
        // Notify the original requester that their request was accepted so their
        // friend list updates in real-time without a page refresh.
        if (notifyUser) {
          notifyUser(requesterId, accepted);
        }
        return accepted;
      } else {
        const rejected = await repo.rejectFriendRequest(requesterId, userId);
        if (!rejected) {
          throw new AppError(404, 'Friend request not found', 'NOT_FOUND');
        }
        // Notify the original requester that their request was rejected so they
        // can remove the pending entry from their list without a page refresh.
        if (notifyUser) {
          notifyUser(requesterId, {
            requesterId,
            addresseeId: userId,
            status: 'rejected' as const,
            createdAt: new Date(),
          });
        }
        return { status: 'rejected' };
      }
    },

    async getFriends(userId: string) {
      const friends = await repo.getFriends(userId);
      return friends.map((f) => {
        if (f && f.friend) {
          return {
            ...f,
            status: isOnline(f.friend.userId) ? 'online' : 'offline',
          };
        }
        return f;
      });
    },

    async removeFriend(userId: string, friendId: string) {
      await repo.deleteFriendship(userId, friendId);
      await privateRooms?.markPrivateReadOnly(userId, friendId);
      if (notifyUser) {
        notifyUser(friendId, {
          requesterId: userId,
          addresseeId: friendId,
          status: 'deleted',
          createdAt: new Date(),
        });
      }
    },

    async blockUser(userId: string, targetUserId: string) {
      if (userId === targetUserId) {
        throw new ValidationError('Cannot block yourself');
      }
      await repo.blockUser(userId, targetUserId);
      await privateRooms?.markPrivateReadOnly(userId, targetUserId);
      if (notifyUser) {
        notifyUser(targetUserId, {
          requesterId: userId,
          addresseeId: targetUserId,
          status: 'blocked',
          createdAt: new Date(),
        });
      }
      return { status: 'blocked' };
    },

    async unblockUser(userId: string, blockedId: string) {
      await repo.unblockUser(userId, blockedId);
      if (await repo.areFriends(userId, blockedId)) {
        await privateRooms?.reopenPrivateRoom?.(userId, blockedId);
      }
      if (notifyUser) {
        notifyUser(blockedId, {
          requesterId: userId,
          addresseeId: blockedId,
          status: 'unblocked',
          createdAt: new Date(),
        });
      }
    },

    async getBlockedUsers(userId: string) {
      return repo.getBlockedUsers(userId);
    }
  };
}
