import { describe, it, expect, beforeEach, mock, spyOn } from 'bun:test';
// @ts-expect-error - Bypassing Bun mock cache with query parameter
import { trackUserConnection, trackUserDisconnection, isUserOnline, getOnlineUsers, clearPresence } from '../../../src/realtime/presence?original';
import type { ChatServer } from '../../../src/realtime/authSocket';

describe('presence tracker', () => {
  let io: any;
  let roomEmit: any;
  let friendRepo: any;

  beforeEach(() => {
    clearPresence();
    roomEmit = mock();
    io = {
      to: mock(() => ({ emit: roomEmit })),
    } as unknown as ChatServer;

    friendRepo = {
      getFriends: mock().mockResolvedValue([
        { friend: { userId: 'friend-1' } },
        { friend: { userId: 'friend-2' } }
      ])
    };
  });

  it('tracks connection, reports online status, and notifies online friends', async () => {
    // Initially offline
    expect(isUserOnline('user-1')).toBe(false);

    // Friend-1 is online (has socket registered)
    await trackUserConnection(io, 'friend-1', 'socket-friend', friendRepo);
    expect(isUserOnline('friend-1')).toBe(true);

    // User-1 connects
    await trackUserConnection(io, 'user-1', 'socket-1', friendRepo);
    expect(isUserOnline('user-1')).toBe(true);
    expect(getOnlineUsers()).toContain('user-1');

    // Should broadcast status 'online' to friend-1's room, but not friend-2 (since friend-2 is offline)
    expect(io.to).toHaveBeenCalledWith('user_friend-1');
    expect(io.to).not.toHaveBeenCalledWith('user_friend-2');
    expect(roomEmit).toHaveBeenCalledWith('user_status', { userId: 'user-1', status: 'online' });
  });

  it('handles trackUserDisconnection gracefully when userId was never tracked', async () => {
    await expect(
      trackUserDisconnection(io, 'unknown-user', 'socket-1', friendRepo)
    ).resolves.toBeUndefined();
  });

  it('suppresses and logs errors from getFriends during trackUserConnection', async () => {
    const errorRepo = { getFriends: mock().mockRejectedValue(new Error('DB down')) };
    const consoleSpy = spyOn(console, 'error').mockImplementation(() => {});

    await expect(trackUserConnection(io, 'user-x', 'socket-1', errorRepo)).resolves.toBeUndefined();

    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
    clearPresence();
  });

  it('suppresses and logs errors from getFriends during trackUserDisconnection', async () => {
    await trackUserConnection(io, 'user-y', 'socket-1', friendRepo);

    const errorRepo = { getFriends: mock().mockRejectedValue(new Error('DB down')) };
    const consoleSpy = spyOn(console, 'error').mockImplementation(() => {});

    await expect(trackUserDisconnection(io, 'user-y', 'socket-1', errorRepo)).resolves.toBeUndefined();

    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('handles multiple socket connections per user and tracks disconnection', async () => {
    // User connects on tab 1
    await trackUserConnection(io, 'user-1', 'socket-tab-1', friendRepo);
    // User connects on tab 2
    await trackUserConnection(io, 'user-1', 'socket-tab-2', friendRepo);

    expect(isUserOnline('user-1')).toBe(true);

    // Disconnect tab 1
    await trackUserDisconnection(io, 'user-1', 'socket-tab-1', friendRepo);
    // User is still online because tab 2 is open
    expect(isUserOnline('user-1')).toBe(true);
    expect(roomEmit).not.toHaveBeenCalledWith('user_status', { userId: 'user-1', status: 'offline' });

    // Friend-1 is online
    await trackUserConnection(io, 'friend-1', 'socket-friend', friendRepo);
    roomEmit.mockClear();

    // Disconnect tab 2
    await trackUserDisconnection(io, 'user-1', 'socket-tab-2', friendRepo);
    // User is now offline
    expect(isUserOnline('user-1')).toBe(false);
    // Should broadcast offline status to friend-1
    expect(io.to).toHaveBeenCalledWith('user_friend-1');
    expect(roomEmit).toHaveBeenCalledWith('user_status', { userId: 'user-1', status: 'offline' });
  });
});
