import { describe, it, expect, mock, type Mock } from 'bun:test';
import { makeFriendService } from '../../../src/services/friendService';
import { AppError } from '../../../src/utils/AppError';

describe('friendService', () => {
  it('getFriends labels each friend from one presence read for the whole list', async () => {
    const mockRepo = {
      getFriends: mock().mockResolvedValue([
        { friend: { userId: 'u2' } },
        { friend: { userId: 'u3' } },
      ]),
    } as any;
    // Injected rather than `mock.module`'d; see backend/tests/CLAUDE.md.
    const readOnlineAmong = mock(async () => new Set(['u2']));
    const service = makeFriendService(mockRepo, undefined, undefined, undefined, readOnlineAmong);

    const result = (await service.getFriends('u1')) as any[];

    expect(result.map((f) => f.status)).toEqual(['online', 'offline']);
    expect(readOnlineAmong).toHaveBeenCalledTimes(1);
    expect(readOnlineAmong).toHaveBeenCalledWith(['u2', 'u3']);
  });

  it('respondFriendRequest throws NOT_FOUND when accepting non-existent request', async () => {
    const mockRepo = {
      isBlocked: mock().mockResolvedValue(false),
      acceptFriendRequest: mock().mockResolvedValue(null)
    } as any;
    const service = makeFriendService(mockRepo);
    await expect(service.respondFriendRequest('u1', 'u2', 'accepted')).rejects.toThrow(AppError);
  });

  it('respondFriendRequest throws NOT_FOUND when rejecting non-existent request', async () => {
    const mockRepo = {
      rejectFriendRequest: mock().mockResolvedValue(null)
    } as any;
    const service = makeFriendService(mockRepo);
    await expect(service.respondFriendRequest('u1', 'u2', 'rejected')).rejects.toThrow(AppError);
  });

  it('blockUser writes the durable block before revoking the room', async () => {
    const order: string[] = [];
    const mockRepo = {
      blockUser: mock(async () => { order.push('blockUser'); }),
    } as any;
    const privateRooms = {
      markPrivateReadOnly: mock(),
      findPrivateRoomIdIfBlocked: mock(async () => { order.push('findPrivateRoomIdIfBlocked'); return 'room-1'; }),
    };
    const removeUserFromRoom = mock(async () => { order.push('removeUserFromRoom'); });
    const service = makeFriendService(mockRepo, undefined, privateRooms as any, removeUserFromRoom as any);

    const result = await service.blockUser('u1', 'u2');

    expect(result).toEqual({ status: 'blocked' });
    expect(order[0]).toBe('blockUser');
    expect(order).toEqual([
      'blockUser',
      'findPrivateRoomIdIfBlocked',
      'removeUserFromRoom',
      'removeUserFromRoom',
    ]);
    // The blocks insert trigger owns the read-only flag; this flow must not
    // write it a second time.
    expect(privateRooms.markPrivateReadOnly).not.toHaveBeenCalled();
  });

  it('blockUser skips socket revocation when a concurrent unblock already lifted the block', async () => {
    const mockRepo = {
      blockUser: mock().mockResolvedValue(undefined),
    } as any;
    // A concurrent unblock committed between blockUser and the lookup, so no
    // room is reported and the reopened room keeps its subscribers.
    const privateRooms = {
      markPrivateReadOnly: mock(),
      findPrivateRoomIdIfBlocked: mock().mockResolvedValue(null),
    };
    const removeUserFromRoom = mock();
    const service = makeFriendService(mockRepo, undefined, privateRooms as any, removeUserFromRoom as any);

    const result = await service.blockUser('u1', 'u2');

    expect(result).toEqual({ status: 'blocked' });
    expect(privateRooms.findPrivateRoomIdIfBlocked).toHaveBeenCalledWith('u1', 'u2');
    expect(privateRooms.markPrivateReadOnly).not.toHaveBeenCalled();
    expect(removeUserFromRoom).not.toHaveBeenCalled();
  });

  it('blockUser leaves the room usable when the durable block fails', async () => {
    const mockRepo = {
      blockUser: mock(async () => { throw new Error('write failed'); }),
    } as any;
    const privateRooms = { markPrivateReadOnly: mock(), findPrivateRoomIdIfBlocked: mock() };
    const removeUserFromRoom = mock();
    const service = makeFriendService(mockRepo, undefined, privateRooms as any, removeUserFromRoom as any);

    await expect(service.blockUser('u1', 'u2')).rejects.toThrow('write failed');
    // Without a block row there is nothing to undo, so the room must not have
    // been left read-only and unsubscribed.
    expect(privateRooms.markPrivateReadOnly).not.toHaveBeenCalled();
    expect(privateRooms.findPrivateRoomIdIfBlocked).not.toHaveBeenCalled();
    expect(removeUserFromRoom).not.toHaveBeenCalled();
  });

  it('unblockUser calls repo.unblockUser', async () => {
    const mockRepo = {
      unblockUser: mock().mockResolvedValue(true),
      areFriends: mock().mockResolvedValue(false),
    } as any;
    const service = makeFriendService(mockRepo);
    const result = await service.unblockUser('u1', 'u2');
    expect(mockRepo.unblockUser).toHaveBeenCalledWith('u1', 'u2');
    expect(mockRepo.areFriends).toHaveBeenCalledWith('u1', 'u2');
    expect(result).toBeUndefined();
  });

  it('unblockUser reopens the private room when the users are still friends', async () => {
    const mockRepo = {
      unblockUser: mock().mockResolvedValue(true),
      areFriends: mock().mockResolvedValue(true),
    } as any;
    const privateRooms = { markPrivateReadOnly: mock(), reopenPrivateRoom: mock() };
    const service = makeFriendService(mockRepo, undefined, privateRooms as any);
    await service.unblockUser('u1', 'u2');
    expect(privateRooms.reopenPrivateRoom).toHaveBeenCalledWith('u1', 'u2');
  });

  it('sendFriendRequest throws when sending to yourself', async () => {
    const service = makeFriendService({} as any);
    await expect(service.sendFriendRequest('u1', 'u1')).rejects.toThrow('Cannot send friend request to yourself');
  });

  it('sendFriendRequest throws FORBIDDEN when blocked', async () => {
    const mockRepo = {
      isBlocked: mock().mockResolvedValue(true)
    } as any;
    const service = makeFriendService(mockRepo);
    await expect(service.sendFriendRequest('u1', 'u2')).rejects.toThrow('Cannot interact with this user');
  });

  it('sendFriendRequest throws when already friends', async () => {
    const mockRepo = {
      isBlocked: mock().mockResolvedValue(false),
      areFriends: mock().mockResolvedValue(true)
    } as any;
    const service = makeFriendService(mockRepo);
    await expect(service.sendFriendRequest('u1', 'u2')).rejects.toThrow('Already friends');
  });

  it('sendFriendRequest creates a request and notifies the target', async () => {
    const request = { requesterId: 'u1', targetUserId: 'u2', status: 'pending' };
    const mockRepo = {
      isBlocked: mock().mockResolvedValue(false),
      areFriends: mock().mockResolvedValue(false),
      getPendingRequests: mock().mockResolvedValue([]),
      sendFriendRequest: mock().mockResolvedValue(request)
    } as any;
    const notifyUser = mock();
    const service = makeFriendService(mockRepo, notifyUser);
    const result = await service.sendFriendRequest('u1', 'u2');
    expect(result as any).toEqual(request);
    expect(notifyUser).toHaveBeenCalledWith('u2', 'friend_request', request);
  });

  it('sendFriendRequest auto-accepts a reciprocal pending request and reopens private room if exists', async () => {
    const accepted = { requesterId: 'u2', targetUserId: 'u1', status: 'accepted' };
    const mockRepo = {
      isBlocked: mock().mockResolvedValue(false),
      areFriends: mock().mockResolvedValue(false),
      getPendingRequests: mock().mockResolvedValue([{ requesterId: 'u2' }]),
      acceptFriendRequest: mock().mockResolvedValue(accepted)
    } as any;
    const notifyUser = mock();
    const privateRooms = { markPrivateReadOnly: mock(), reopenPrivateRoom: mock() };
    const service = makeFriendService(mockRepo, notifyUser, privateRooms as any);
    const result = await service.sendFriendRequest('u1', 'u2');
    expect(result as any).toEqual(accepted);
    expect(mockRepo.acceptFriendRequest).toHaveBeenCalledWith('u2', 'u1');
    expect(privateRooms.reopenPrivateRoom).toHaveBeenCalledWith('u1', 'u2');
    expect(notifyUser).toHaveBeenCalledWith('u2', 'friend_request', accepted);
  });

  it('respondFriendRequest accepted reopens private room if exists', async () => {
    const accepted = { requesterId: 'u2', targetUserId: 'u1', status: 'accepted' };
    const mockRepo = {
      isBlocked: mock().mockResolvedValue(false),
      acceptFriendRequest: mock().mockResolvedValue(accepted)
    } as any;
    const privateRooms = { markPrivateReadOnly: mock(), reopenPrivateRoom: mock() };
    const service = makeFriendService(mockRepo, undefined, privateRooms as any);
    const result = await service.respondFriendRequest('u1', 'u2', 'accepted');
    expect(result as any).toEqual(accepted);
    expect(privateRooms.reopenPrivateRoom).toHaveBeenCalledWith('u2', 'u1');
  });

  it('respondFriendRequest accepted throws FORBIDDEN when blocked', async () => {
    const mockRepo = {
      isBlocked: mock().mockResolvedValue(true)
    } as any;
    const service = makeFriendService(mockRepo);
    await expect(service.respondFriendRequest('u1', 'u2', 'accepted')).rejects.toThrow('Cannot interact with this user');
  });

  it('respondFriendRequest rejected returns rejected status', async () => {
    const mockRepo = {
      rejectFriendRequest: mock().mockResolvedValue({ status: 'rejected' })
    } as any;
    const service = makeFriendService(mockRepo);
    const result = await service.respondFriendRequest('u1', 'u2', 'rejected');
    expect(result).toEqual({ status: 'rejected' });
  });

  it('removeFriend deletes the friendship and marks the private room read-only', async () => {
    const mockRepo = {
      deleteFriendship: mock().mockResolvedValue(undefined)
    } as any;
    const privateRooms = { markPrivateReadOnly: mock() };
    const service = makeFriendService(mockRepo, undefined, privateRooms as any);
    await service.removeFriend('u1', 'u2');
    expect(mockRepo.deleteFriendship).toHaveBeenCalledWith('u1', 'u2');
    expect(privateRooms.markPrivateReadOnly).toHaveBeenCalledWith('u1', 'u2');
  });

  it('blockUser throws when blocking yourself', async () => {
    const service = makeFriendService({} as any);
    await expect(service.blockUser('u1', 'u1')).rejects.toThrow('Cannot block yourself');
  });

  it('blockUser blocks and marks the room read-only without deleting the friendship', async () => {
    const mockRepo = {
      blockUser: mock().mockResolvedValue(undefined),
    } as any;
    const privateRooms = { markPrivateReadOnly: mock() };
    const service = makeFriendService(mockRepo, undefined, privateRooms as any);
    const result = await service.blockUser('u1', 'u2');
    expect(result).toEqual({ status: 'blocked' });
    expect(mockRepo.blockUser).toHaveBeenCalledWith('u1', 'u2');
    expect(privateRooms.markPrivateReadOnly).toHaveBeenCalledWith('u1', 'u2');
  });

  it('removes the blocked user from the private room after the block is durable', async () => {
    const mockRepo = {
      blockUser: mock().mockResolvedValue(undefined),
    } as any;
    const privateRooms = { markPrivateReadOnly: mock().mockResolvedValue('private-room-1') };
    const removeUserFromRoom = mock();
    const service = makeFriendService(
      mockRepo,
      undefined,
      privateRooms as any,
      removeUserFromRoom,
    );

    await service.blockUser('u1', 'u2');

    expect(removeUserFromRoom).toHaveBeenCalledWith('u2', 'private-room-1');
  });

  it('getPendingRequests, getFriends and getBlockedUsers delegate to the repo', async () => {
    const mockRepo = {
      getPendingRequests: mock().mockResolvedValue(['p']),
      getFriends: mock().mockResolvedValue(['f']),
      getBlockedUsers: mock().mockResolvedValue(['b'])
    } as any;
    const service = makeFriendService(mockRepo);
    expect((await service.getPendingRequests('u1')) as any).toEqual(['p']);
    expect((await service.getFriends('u1')) as any).toEqual(['f']);
    expect((await service.getBlockedUsers('u1')) as any).toEqual(['b']);
  });
});
