import { AppError, ConflictError, ValidationError } from '../utils/AppError';
import type { makeFriendRepository } from '../models/friendRepository';
import { isUserOnline } from '../realtime/presence';

export function makeFriendService(
  repo: ReturnType<typeof makeFriendRepository>,
  notifyUser?: (userId: string, eventName: string, payload: unknown) => void,
  privateRooms?: {
    markPrivateReadOnly(userA: string, userB: string): Promise<string | null>;
    findPrivateRoomIdIfBlocked?(userA: string, userB: string): Promise<string | null>;
    createPrivate?(userA: string, userB: string): Promise<unknown>;
    reopenPrivateRoom?(userA: string, userB: string): Promise<void>;
  },
  removeUserFromRoom?: (userId: string, roomId: string) => void | Promise<void>,
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
          notifyUser(targetUserId, 'friend_request', accepted);
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
        notifyUser(targetUserId, 'friend_request', request);
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
          notifyUser(requesterId, 'friend_request', accepted);
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
          notifyUser(requesterId, 'friend_request', {
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
            status: isUserOnline(f.friend.userId) ? 'online' : 'offline',
          };
        }
        return f;
      });
    },

    async removeFriend(userId: string, friendId: string) {
      await repo.deleteFriendship(userId, friendId);
      await privateRooms?.markPrivateReadOnly(userId, friendId);
      if (notifyUser) {
        notifyUser(friendId, 'friend_request', {
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
      const block = async () => {
        // The durable block row is written first so a later failure can never
        // leave the room read-only and unsubscribed with no block record to
        // undo it. Ordering it first is also safe for the live transport:
        // `blockUser` and message authorization take the same pair advisory
        // lock and authorization re-reads `blocks` inside its own transaction,
        // so once the block commits no further message can be published to
        // this room. The read-only flag and the socket revocation below are
        // the cleanup half of the same state change.
        // Writing the block is the whole durable half of this operation: the
        // `blocks` insert trigger closes the private room inside the same
        // transaction, so this flow must not set the read-only flag itself.
        // Two writers for one invariant is what previously let a concurrent
        // unblock reopen the room and then have this request re-close it,
        // leaving it read-only with no block row to undo it.
        await repo.blockUser(userId, targetUserId);
        // The pair mutex is process-local and `blockUser`'s advisory lock ends
        // with its transaction, so the block can already be lifted by another
        // process. A null here means exactly that, and the room keeps its
        // subscriptions because it is legitimately open again.
        const privateRoomId = privateRooms?.findPrivateRoomIdIfBlocked
          ? await privateRooms.findPrivateRoomIdIfBlocked(userId, targetUserId)
          : await privateRooms?.markPrivateReadOnly(userId, targetUserId);
        if (privateRoomId) {
          await removeUserFromRoom?.(userId, privateRoomId);
          await removeUserFromRoom?.(targetUserId, privateRoomId);
        }
        notifyUser?.(targetUserId, 'friend_request', {
          requesterId: userId,
          addresseeId: targetUserId,
          status: 'blocked',
          createdAt: new Date(),
        });
        return { status: 'blocked' as const };
      };
      if (repo.withUserPairLock) return repo.withUserPairLock(userId, targetUserId, block);
      return block();
    },

    async unblockUser(userId: string, blockedId: string) {
      const unblock = async () => {
        await repo.unblockUser(userId, blockedId);
        if (await repo.areFriends(userId, blockedId)) {
          await privateRooms?.reopenPrivateRoom?.(userId, blockedId);
        }
        if (notifyUser) {
          notifyUser(blockedId, 'friend_request', {
            requesterId: userId,
            addresseeId: blockedId,
            status: 'unblocked',
            createdAt: new Date(),
          });
        }
      };

      // Keep removing the block and reopening the private room in the same
      // pair-ordered critical section as createPrivate/blockUser.
      if (repo.withUserPairLock) {
        await repo.withUserPairLock(userId, blockedId, unblock);
      } else {
        await unblock();
      }
    },

    async getBlockedUsers(userId: string) {
      return repo.getBlockedUsers(userId);
    }
  };
}
