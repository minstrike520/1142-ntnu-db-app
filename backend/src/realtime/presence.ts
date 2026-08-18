import type { ChatServer } from './authSocket';

interface FriendPresenceDeps {
  getFriends(userId: string): Promise<{ friend: { userId: string } }[]>;
}

// Keep a disconnected user online during the short reconnect grace period.
// This prevents a mobile network handoff from producing offline/online flicker.
const userSockets = new Map<string, Set<string>>();
const pendingDisconnects = new Map<string, ReturnType<typeof setTimeout>>();

const gracePeriodMs = (): number => {
  // Unit tests default to immediate transitions so they do not leave timers
  // behind; production keeps the reconnect grace period unless explicitly
  // configured otherwise.
  const configured = Number(process.env.PRESENCE_GRACE_MS ?? (process.env.NODE_ENV === 'test' ? 0 : 3_000));
  return Number.isFinite(configured) && configured >= 0 ? configured : 3_000;
};

export const clearPresence = (): void => {
  for (const timer of pendingDisconnects.values()) clearTimeout(timer);
  pendingDisconnects.clear();
  userSockets.clear();
};

export const getOnlineUsers = (): string[] => Array.from(new Set([
  ...userSockets.keys(),
  ...pendingDisconnects.keys(),
]));

export const isUserOnline = (userId: string): boolean => {
  const sockets = userSockets.get(userId);
  return Boolean((sockets && sockets.size > 0) || pendingDisconnects.has(userId));
};

const broadcastStatus = async (
  io: ChatServer,
  userId: string,
  status: 'online' | 'offline',
  friendRepo: FriendPresenceDeps,
): Promise<void> => {
  try {
    const friends = await friendRepo.getFriends(userId);
    for (const f of friends) {
      if (isUserOnline(f.friend.userId)) {
        io.to(`user_${f.friend.userId}`).emit('user_status', { userId, status });
      }
    }
  } catch (err) {
    console.error(`Failed to broadcast ${status} status for user ${userId}:`, err);
  }
};

export const trackUserConnection = async (
  io: ChatServer,
  userId: string,
  socketId: string,
  friendRepo: FriendPresenceDeps,
) => {
  const pending = pendingDisconnects.get(userId);
  const wasGracefullyReconnecting = pending !== undefined;
  if (pending) {
    clearTimeout(pending);
    pendingDisconnects.delete(userId);
  }

  let sockets = userSockets.get(userId);
  const wasOffline = !sockets || sockets.size === 0;
  if (!sockets) {
    sockets = new Set<string>();
    userSockets.set(userId, sockets);
  }
  sockets.add(socketId);

  if (wasOffline && !wasGracefullyReconnecting) await broadcastStatus(io, userId, 'online', friendRepo);
};

export const trackUserDisconnection = async (
  io: ChatServer,
  userId: string,
  socketId: string,
  friendRepo: FriendPresenceDeps,
) => {
  const sockets = userSockets.get(userId);
  if (!sockets || !sockets.has(socketId)) return;

  sockets.delete(socketId);
  if (sockets.size > 0) return;

  const delay = gracePeriodMs();
  if (delay === 0) {
    userSockets.delete(userId);
    await broadcastStatus(io, userId, 'offline', friendRepo);
    return;
  }

  // Keep the user online during the grace period. A reconnect cancels this
  // timer and restores the session without an offline transition.
  const prior = pendingDisconnects.get(userId);
  if (prior) clearTimeout(prior);
  const timer = setTimeout(() => {
    pendingDisconnects.delete(userId);
    const current = userSockets.get(userId);
    if (current && current.size === 0) {
      userSockets.delete(userId);
      void broadcastStatus(io, userId, 'offline', friendRepo);
    }
  }, delay);
  pendingDisconnects.set(userId, timer);
};
