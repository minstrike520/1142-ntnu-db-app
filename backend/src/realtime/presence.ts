import type pino from 'pino';
import type { ChatServer } from './authSocket';
import type { PresenceStore } from './presenceStore';
import { DEFAULT_PRESENCE_REFRESH_DIVISOR, env } from '../config/env';
import { logger as defaultLogger } from '../utils/logger';

interface FriendPresenceDeps {
  getFriends(userId: string): Promise<{ friend: { userId: string } }[]>;
}

/**
 * Ceiling on how long releasing leases may hold up a shutdown.
 *
 * Matched to `DEFAULT_CLOSE_TIMEOUT_MS` in `utils/redis.ts`, which bounds the
 * step that runs immediately after: a deployment must not be held open by an
 * unreachable Redis, and an unreleased lease costs at most `presenceTtlMs` of
 * one user showing online.
 */
export const DEFAULT_PRESENCE_STOP_TIMEOUT_MS = 2_000;

/** Resolve when the work does or when the deadline passes, whichever is first. */
const withDeadline = async (work: Promise<unknown>, ms: number): Promise<void> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
    // Never let the deadline itself be the reason the process stays alive.
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
 * A presence answer that can admit it does not know.
 *
 * `unknown` is only ever produced by a Redis this instance could not reach
 * while some other instance might still hold a lease — never by a deployment
 * running without Redis, where one process seeing no connection *is* the whole
 * truth.
 *
 * It exists because collapsing it to `offline` is safe for a display and unsafe
 * for a decision. `utils/inactivityJob.ts` acts on offline by escalating to
 * `checkInactivity`, which past the warning threshold notifies a user's
 * emergency contacts — a one-shot, recorded delivery that no later tick undoes.
 * Alerting someone's contacts because Redis blinked is not a degradation anyone
 * would accept, and a skipped hourly tick costs nothing.
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
  /**
   * Whether the user has a live connection anywhere.
   *
   * Asynchronous because the answer can live on another instance. This
   * instance's own connections are still answered from memory without a round
   * trip — they are the part of the answer it is authoritative for.
   */
  isUserOnline(userId: string): Promise<boolean>;
  /**
   * The same question as `isUserOnline`, without collapsing "Redis did not
   * answer" into "offline". See `PresenceState`.
   */
  presenceOf(userId: string): Promise<PresenceState>;
  /**
   * The subset of these users who are online, in one round trip.
   *
   * For the list endpoints, which ask about a whole page at once. Unreachable
   * Redis answers with whatever this instance can see, which is the same
   * degradation `isUserOnline` makes and is correct for a display.
   */
  onlineAmong(userIds: string[]): Promise<Set<string>>;
  getOnlineUsers(): Promise<string[]>;
  /** Drop this instance's state and release the leases it is holding. */
  clearPresence(): Promise<void>;
  /** Release every lease and stop the heartbeat. Idempotent. */
  stop(): Promise<void>;
}

export interface CreatePresenceTrackerOptions {
  /** Absent means single-node: presence is whatever this process can see. */
  store?: PresenceStore;
  /** Read per call, so a test can change `PRESENCE_GRACE_MS` between cases. */
  graceMs?: () => number;
  /** Lease lifetime; also sets the heartbeat period. */
  ttlMs?: number;
  /** How many heartbeats fit in one lease. */
  refreshDivisor?: number;
  /**
   * Ceiling on how long `stop()` may spend handing leases back.
   *
   * Shutdown must terminate whatever Redis is doing, the same bounded-fallback
   * shape `utils/redis.ts` uses for `close()`. Leases that miss this window are
   * not lost work — they expire on their own within `ttlMs`.
   */
  stopTimeoutMs?: number;
  logger?: pino.Logger;
  /** Injected so tests drive the heartbeat instead of waiting for it. */
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
   * Tell a user's friends that their status changed.
   *
   * The per-friend check is deliberately the *local* one. `io.to()` reaches
   * only sockets held by this process — the publisher is single-process, by
   * design and by its own doc comment — so a friend connected elsewhere cannot
   * be reached from here whatever Redis says, and asking Redis about each
   * friend would buy a round trip per friend per connect and change nothing.
   * Delivering `user_status` across instances is the event bus's job (#475),
   * not this module's.
   */
  const broadcastStatus = async (
    io: ChatServer,
    userId: string,
    status: PresenceStatus,
    friendRepo: FriendPresenceDeps,
  ): Promise<void> => {
    try {
      const friends = await friendRepo.getFriends(userId);
      for (const f of friends) {
        if (isLocallyOnline(f.friend.userId)) {
          io.to(`user_${f.friend.userId}`).emit('user_status', { userId, status });
        }
      }
    } catch (err) {
      console.error(`Failed to broadcast ${status} status for user ${userId}:`, err);
    }
  };

  /**
   * Re-take every lease this instance is holding.
   *
   * The window where this could resurrect a user who left mid-refresh is closed
   * by issue order rather than by a lock: the membership check and the `hold`
   * for every user are issued in one synchronous burst, before control returns
   * to the event loop, so a disconnect that arrives afterwards always issues its
   * `release` *behind* them on the same command connection. Redis applies them
   * in that order, so the last word belongs to the disconnect. Introducing an
   * `await` inside this loop would break that and re-open the window.
   */
  const refreshLeases = async (): Promise<void> => {
    if (!store || stopped) return;
    const users = heldUsers();
    if (users.length === 0) return;
    await Promise.all(
      users.map((userId) => {
        // A user whose grace period ended between building the list and getting
        // here no longer wants a lease; re-taking one would resurrect them.
        if (!isLocallyOnline(userId)) return Promise.resolve();
        return store.hold(userId, localSocketCount(userId));
      }),
    );
  };

  const startHeartbeat = (): void => {
    // No lease to refresh without a store, and no timer either: importing this
    // module must not leave the test runner or the E2E suite holding the loop
    // open.
    if (!store || heartbeat !== undefined) return;
    const period = Math.max(1, Math.floor(ttlMs / Math.max(1, refreshDivisor)));
    heartbeat = setIntervalFn(() => {
      void refreshLeases().catch((err) => {
        logger.debug({ err }, 'Presence heartbeat failed');
      });
    }, period);
    (heartbeat as { unref?: () => void }).unref?.();
  };

  /** The user has no connection here any more: drop the lease and settle the edge. */
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
    // A failed release means the lease is still out there and will expire on its
    // own. Announcing offline anyway is the right call: this instance knows the
    // user has no connection here, and falling silent would leave the friends it
    // *can* reach showing a stale online.
    const goneEverywhere = !result.ok || result.value === 0;
    if (goneEverywhere) await broadcastStatus(io, userId, 'offline', friendRepo);
  };

  const presenceOf = async (userId: string): Promise<PresenceState> => {
    // Answered from memory when this instance holds the connection: it is the
    // half of the answer this process is authoritative for, and no round trip
    // can improve on it.
    if (isLocallyOnline(userId)) return 'online';
    // Without a store this process *is* the deployment, so seeing nothing is
    // knowing they are offline rather than failing to find out.
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
      // `0` holders before this call is the definition of "first connection
      // anywhere", so it covers the second tab, the second instance and the
      // reconnect inside the grace period without any of them being a special
      // case: in all three this instance's own lease was already out.
      const firstAnywhere = result.ok
        ? result.value === 0
        : wasLocallyOffline && !wasGracefullyReconnecting;
      if (firstAnywhere) await broadcastStatus(io, userId, 'online', friendRepo);
    },

    async trackUserDisconnection(io, userId, socketId, friendRepo) {
      const sockets = userSockets.get(userId);
      if (!sockets || !sockets.has(socketId)) return;

      sockets.delete(socketId);
      // Other tabs are still open here, so the lease stays exactly as it is. Its
      // stored connection count is a hint the heartbeat refreshes, not a live
      // counter — nobody reads it to decide anything, and spending a round trip
      // on every tab close to keep it exact would be paying for a diagnostic.
      if (sockets.size > 0) return;

      const delay = graceMs();
      if (delay === 0) {
        await releaseUser(io, userId, friendRepo);
        return;
      }

      // Keep the user online during the grace period. A reconnect cancels this
      // timer and restores the session without an offline transition.
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
      // A Redis this instance cannot reach makes it single-node again, which is
      // the same answer it would give with no Redis configured at all.
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
      // Release rather than let the leases expire. Shutdown is the one case
      // where this process knows for certain that its users are gone, and
      // `index.ts` keeps Redis open through the drain precisely so this write
      // still lands. A grace timer is cancelled outright: a process that is
      // going away is not a reconnect anyone should wait for.
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

/**
 * The process-wide tracker.
 *
 * Presence is genuinely one thing per process, and every caller reaches it
 * through these bindings rather than through an import of a mutable instance,
 * so `configurePresence` can replace it once the composition root knows whether
 * there is a Redis to share it through. Until then — and in the E2E suite,
 * which imports the app without ever calling `connect()` — it runs local-only,
 * which is exactly the behaviour this module had before Redis existed.
 *
 * Tests build their own with `createPresenceTracker` and inject it; nothing
 * here needs `mock.module`.
 */
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
