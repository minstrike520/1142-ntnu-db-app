import type { ChatServer } from './authSocket';

interface FriendPresenceDeps {
  getFriends(userId: string): Promise<{ friend: { userId: string } }[]>;
}

// Map of userId -> Set of socketId
const userSockets = new Map<string, Set<string>>();

export const clearPresence = (): void => {
  userSockets.clear();
};

export const getOnlineUsers = (): string[] => {
  return Array.from(userSockets.keys());
};

export const isUserOnline = (userId: string): boolean => {
  const sockets = userSockets.get(userId);
  return sockets ? sockets.size > 0 : false;
};

export const trackUserConnection = async (
  io: ChatServer,
  userId: string,
  socketId: string,
  friendRepo: FriendPresenceDeps
) => {
  let sockets = userSockets.get(userId);
  const wasOffline = !sockets || sockets.size === 0;

  if (!sockets) {
    sockets = new Set<string>();
    userSockets.set(userId, sockets);
  }
  sockets.add(socketId);

  if (wasOffline) {
    try {
      const friends = await friendRepo.getFriends(userId);
      for (const f of friends) {
        const friendId = f.friend.userId;
        if (isUserOnline(friendId)) {
          io.to(`user_${friendId}`).emit('user_status', {
            userId,
            status: 'online',
          });
        }
      }
    } catch (err) {
      console.error(`Failed to broadcast online status for user ${userId}:`, err);
    }
  }
};

export const trackUserDisconnection = async (
  io: ChatServer,
  userId: string,
  socketId: string,
  friendRepo: FriendPresenceDeps
) => {
  const sockets = userSockets.get(userId);
  if (sockets) {
    sockets.delete(socketId);
    if (sockets.size === 0) {
      userSockets.delete(userId);
      try {
        const friends = await friendRepo.getFriends(userId);
        for (const f of friends) {
          const friendId = f.friend.userId;
          if (isUserOnline(friendId)) {
            io.to(`user_${friendId}`).emit('user_status', {
              userId,
              status: 'offline',
            });
          }
        }
      } catch (err) {
        console.error(`Failed to broadcast offline status for user ${userId}:`, err);
      }
    }
  }
};
