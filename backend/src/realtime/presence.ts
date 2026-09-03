import type pino from 'pino';
import type { ChatServer } from './authSocket';
import type { PresenceStore } from './presenceStore';
import { DEFAULT_PRESENCE_REFRESH_DIVISOR, env } from '../config/env';
import { logger as defaultLogger } from '../utils/logger';

interface FriendPresenceDeps {
  getFriends(userId: string): Promise<{ friend: { userId: string } }[]>;
}

/** Max time allowed for releasing presence leases during shutdown. */
export const DEFAULT_PRESENCE_STOP_TIMEOUT_MS = 2_000;

/** Races a promise against a timeout deadline. */
const withDeadline = async (work: Promise<unknown>, ms: number): Promise<void> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
  try {
    await Promise.race([work.then(() => undefined, () => undefined), deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

export type PresenceStatus = 'online' | 'offline';

/**
 * Presence state with tri-state support.
 * 'unknown' is returned when Redis is unreachable, preventing false offline escalations.
 */
export type PresenceState = PresenceStatus | 'unknown';

export interface PresenceTracker {
  trackUserConnection(
    io: ChatServer,
    userId: string,
    socketId: string,
    friendRepo: FriendPresenceDeps,
  ): Promise<void>;
  trackUserDisconnection(
    io: ChatServer,
    userId: string,
    socketId: string,
    friendRepo: FriendPresenceDeps,
  ): Promise<void>;
  /** Returns true if user has an active connection locally or in Redis. */
  isUserOnline(userId: string): Promise<boolean>;
  /** Returns 'online', 'offline', or 'unknown' if Redis cannot be reached. */
  presenceOf(userId: string): Promise<PresenceState>;
  /** Returns the subset of user IDs currently online in a single check. */
  onlineAmong(userIds: string[]): Promise<Set<string>>;
  getOnlineUsers(): Promise<string[]>;
  /** Clears local presence state and releases held leases. */
  clearPresence(): Promise<void>;
  /** Releases held leases and stops heartbeat. Idempotent. */
  stop(): Promise<void>;
}

export interface CreatePresenceTrackerOptions {
  /** Optional distributed presence store; absent runs in single-node mode. */
  store?: PresenceStore;
  /** Reconnect grace period in milliseconds before broadcasting offline. */
  graceMs?: () => number;
  /** Lease TTL and heartbeat period. */
  ttlMs?: number;
  /** Number of heartbeats within one lease TTL window. */
  refreshDivisor?: number;
  /** Max time allowed for releasing leases during stop(). */
  stopTimeoutMs?: number;
  logger?: pino.Logger;
  setIntervalFn?: (handler: () => void, ms: number) => ReturnType<typeof setInterval> | number;
  clearIntervalFn?: (handle: ReturnType<typeof setInterval> | number) => void;
}

export const createPresenceTracker = ({
  store,
  graceMs = () => env().realtime.presenceGraceMs,
  ttlMs = env().realtime.presenceTtlMs,
  refreshDivisor = DEFAULT_PRESENCE_REFRESH_DIVISOR,
  stopTimeoutMs = DEFAULT_PRESENCE_STOP_TIMEOUT_MS,
  logger = defaultLogger,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
}: CreatePresenceTrackerOptions = {}): PresenceTracker => {
  // This instance's own connections. Still a local map with Redis in play, and
  // not a cache of it: the reconnect grace period, the "which socket left"
  // bookkeeping and the answer to "is this user on *this* box" are all local
  // questions, and the only thing another instance needs to know is the single
  // bit the lease carries.
  const userSockets = new Map<string, Set<string>>();
  // Keep a disconnected user online during the short reconnect grace period.
  // This prevents a mobile network handoff from producing offline/online
  // flicker. The Redis lease is deliberately held for the whole window too, so
  // a reconnect that lands on a different instance also sees no transition.
  const pendingDisconnects = new Map<string, ReturnType<typeof setTimeout>>();

  let heartbeat: ReturnType<typeof setInterval> | number | undefined;
  let stopped = false;

  const localSocketCount = (userId: string): number => userSockets.get(userId)?.size ?? 0;

  /**
   * Users this instance is currently holding a lease for.
   *
   * A pending disconnect counts: the grace period is a promise that the user
   * still reads as online, and dropping the lease at the start of it would
   * break that promise for every other instance.
   */
  const heldUsers = (): string[] =>
    Array.from(new Set([...userSockets.keys(), ...pendingDisconnects.keys()]));

  const isLocallyOnline = (userId: string): boolean =>
    localSocketCount(userId) > 0 || pendingDisconnects.has(userId);

  /**
   * Broadcasts an online/offline transition to the user's friends.
   *
   * Addressed to the friends' personal rooms and left to the adapter, rather
   * than filtered against who this instance can see. `user_<id>` is joined the
   * moment the socket is (`realtime/socketServer.ts`), so room membership is
   * the transport's own answer to "is there a session to deliver to" — and
   * since #475 it is a cluster-wide answer. Asking presence instead would
   * re-derive it from leases that lag a live socket by up to their refresh
   * period, and would drop every remote friend whenever the command connection
   * is down while the publisher that carries the frame is fine.
   *
   * One `emit` for the whole list, not one per friend: `to()` unions the rooms
   * into a single broadcast, so the cluster adapter publishes one frame however
   * many friends it names, and each instance discards the rooms it holds no
   * sockets for.
   */
  const broadcastStatus = async (
    io: ChatServer,
    userId: string,
    status: PresenceStatus,
    friendRepo: FriendPresenceDeps,
  ): Promise<void> => {
    try {
      const friends = await friendRepo.getFriends(userId);
      const rooms = friends.map((f) => `user_${f.friend.userId}`);
      // No rooms is not an empty audience: `Adapter#apply` reads an empty room
      // set as *every* socket in the namespace, so emitting here would announce
      // a friendless user's presence to the whole deployment.
      if (rooms.length === 0) return;
      io.to(rooms).emit('user_status', { userId, status });
    } catch (err) {
      console.error(`Failed to broadcast ${status} status for user ${userId}:`, err);
    }
  };

  /** Refreshes presence leases in Redis for all currently held users. */
  const refreshLeases = async (): Promise<void> => {
    if (!store || stopped) return;
    const users = heldUsers();
    if (users.length === 0) return;
    await Promise.all(
      users.map((userId) => {
        if (!isLocallyOnline(userId)) return Promise.resolve();
        return store.hold(userId, localSocketCount(userId));
      }),
    );
  };

  const startHeartbeat = (): void => {
    if (!store || heartbeat !== undefined) return;
    const period = Math.max(1, Math.floor(ttlMs / Math.max(1, refreshDivisor)));
    heartbeat = setIntervalFn(() => {
      void refreshLeases().catch((err) => {
        logger.debug({ err }, 'Presence heartbeat failed');
      });
    }, period);
    (heartbeat as { unref?: () => void }).unref?.();
  };

  /** Drops local presence and releases the Redis lease for a disconnected user. */
  const releaseUser = async (
    io: ChatServer,
    userId: string,
    friendRepo: FriendPresenceDeps,
  ): Promise<void> => {
    userSockets.delete(userId);
    pendingDisconnects.delete(userId);

    if (!store) {
      await broadcastStatus(io, userId, 'offline', friendRepo);
      return;
    }

    const result = await store.release(userId);
    const goneEverywhere = !result.ok || result.value === 0;
    if (goneEverywhere) await broadcastStatus(io, userId, 'offline', friendRepo);
  };

  const presenceOf = async (userId: string): Promise<PresenceState> => {
    if (isLocallyOnline(userId)) return 'online';
    if (!store) return 'offline';
    const result = await store.isOnline(userId);
    if (!result.ok) return 'unknown';
    return result.value ? 'online' : 'offline';
  };

  return {
    async trackUserConnection(io, userId, socketId, friendRepo) {
      if (stopped) return;

      const pending = pendingDisconnects.get(userId);
      const wasGracefullyReconnecting = pending !== undefined;
      if (pending) {
        clearTimeout(pending);
        pendingDisconnects.delete(userId);
      }

      let sockets = userSockets.get(userId);
      const wasLocallyOffline = !sockets || sockets.size === 0;
      if (!sockets) {
        sockets = new Set<string>();
        userSockets.set(userId, sockets);
      }
      sockets.add(socketId);

      if (!store) {
        if (wasLocallyOffline && !wasGracefullyReconnecting) {
          await broadcastStatus(io, userId, 'online', friendRepo);
        }
        return;
      }

      startHeartbeat();
      const result = await store.hold(userId, sockets.size);
      const firstAnywhere = result.ok
        ? result.value === 0
        : wasLocallyOffline && !wasGracefullyReconnecting;
      if (firstAnywhere) await broadcastStatus(io, userId, 'online', friendRepo);
    },

    async trackUserDisconnection(io, userId, socketId, friendRepo) {
      const sockets = userSockets.get(userId);
      if (!sockets || !sockets.has(socketId)) return;

      sockets.delete(socketId);
      if (sockets.size > 0) return;

      const delay = graceMs();
      if (delay === 0) {
        await releaseUser(io, userId, friendRepo);
        return;
      }

      // Delay offline broadcast during the reconnect grace period.
      const prior = pendingDisconnects.get(userId);
      if (prior) clearTimeout(prior);
      const timer = setTimeout(() => {
        pendingDisconnects.delete(userId);
        if (localSocketCount(userId) > 0) return;
        void releaseUser(io, userId, friendRepo).catch((err) => {
          logger.debug({ err, userId }, 'Failed to release a presence lease after the grace period');
        });
      }, delay);
      timer.unref?.();
      pendingDisconnects.set(userId, timer);
    },

    presenceOf,

    async isUserOnline(userId) {
      return (await presenceOf(userId)) === 'online';
    },

    async onlineAmong(userIds) {
      const online = new Set<string>();
      const unresolved: string[] = [];
      for (const userId of new Set(userIds)) {
        if (isLocallyOnline(userId)) online.add(userId);
        else unresolved.push(userId);
      }
      if (!store || unresolved.length === 0) return online;

      const result = await store.areOnline(unresolved);
      if (result.ok) for (const userId of result.value) online.add(userId);
      return online;
    },

    async getOnlineUsers() {
      const local = heldUsers();
      if (!store) return local;
      const result = await store.onlineUsers();
      return result.ok ? [...new Set([...local, ...result.value])] : local;
    },

    async clearPresence() {
      for (const timer of pendingDisconnects.values()) clearTimeout(timer);
      const users = heldUsers();
      pendingDisconnects.clear();
      userSockets.clear();
      if (store) await Promise.all(users.map((userId) => store.release(userId)));
    },

    async stop() {
      stopped = true;
      if (heartbeat !== undefined) {
        clearIntervalFn(heartbeat);
        heartbeat = undefined;
      }
      for (const timer of pendingDisconnects.values()) clearTimeout(timer);
      const users = heldUsers();
      pendingDisconnects.clear();
      userSockets.clear();
      if (!store || users.length === 0) return;
      await withDeadline(
        Promise.all(users.map((userId) => store.release(userId))),
        stopTimeoutMs,
      );
    },
  };
};

/** Default process-wide presence tracker singleton. */
let current: PresenceTracker = createPresenceTracker();

export const configurePresence = (options: CreatePresenceTrackerOptions): PresenceTracker => {
  const previous = current;
  current = createPresenceTracker(options);
  void previous.stop();
  return current;
};

export const trackUserConnection = (
  io: ChatServer,
  userId: string,
  socketId: string,
  friendRepo: FriendPresenceDeps,
): Promise<void> => current.trackUserConnection(io, userId, socketId, friendRepo);

export const trackUserDisconnection = (
  io: ChatServer,
  userId: string,
  socketId: string,
  friendRepo: FriendPresenceDeps,
): Promise<void> => current.trackUserDisconnection(io, userId, socketId, friendRepo);

export const isUserOnline = (userId: string): Promise<boolean> => current.isUserOnline(userId);

export const presenceOf = (userId: string): Promise<PresenceState> => current.presenceOf(userId);

export const onlineAmong = (userIds: string[]): Promise<Set<string>> =>
  current.onlineAmong(userIds);

export const getOnlineUsers = (): Promise<string[]> => current.getOnlineUsers();

export const clearPresence = (): Promise<void> => current.clearPresence();
