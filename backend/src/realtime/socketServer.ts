import type { FriendResponse } from '@shared/types';
import { ForbiddenError, ValidationError } from '../utils/AppError';
import type { IRoomMemberRepository } from '../models/IRoomMemberRepository';
import type { ChatServer } from './authSocket';
import { trackUserConnection, trackUserDisconnection, type PresenceTracker } from './presence';
import type { TypingStore } from './typingStore';
import { mapErrorToApiShape } from '../utils/mapError';
import { env } from '../config/env';

interface SocketDeps {
  roomMemberRepository: Pick<IRoomMemberRepository, 'findMember' | 'findByUser'>;
  friendRepository?: { getFriends(userId: string): Promise<FriendResponse[]> };
  withRoomSubscriptionLock?: <T>(
    userId: string,
    roomId: string,
    operation: () => Promise<T> | T,
  ) => Promise<T>;
  /** Optional injected presence tracker (defaults to process singleton). */
  presence?: Pick<PresenceTracker, 'trackUserConnection' | 'trackUserDisconnection'>;
  /**
   * Optional cross-instance typing claims. Absent means single-node typing,
   * exactly as before Redis existed; see `bootstrap/realtime.ts`.
   */
  typingStore?: TypingStore;
}

const maxSessionsPerUser = (): number => env().realtime.maxSessionsPerUser;

const typingTtlMs = (): number => env().realtime.typingTtlMs;

/** Timeout before unestablished socket reservations are released. */
const sessionReservationTtlMs = (): number => env().realtime.sessionReservationTtlMs;

/** Attaches ephemeral Socket.IO listeners for presence and typing indicators. */
export const attachSockets = (io: ChatServer, deps: SocketDeps): void => {
  const presence = deps.presence ?? { trackUserConnection, trackUserDisconnection };
  const sessionLimit = maxSessionsPerUser();
  const sessionCounts = new Map<string, number>();

  /** Tracks active typing expiration timer and check timestamp per socket and room. */
  const typingClaims = new Map<string, { expiry: ReturnType<typeof setTimeout>; checkedAt: number }>();

  /** Maps roomId -> userId -> active socketIds claiming typing state. */
  const typingRooms = new Map<string, Map<string, Set<string>>>();

  /** Records a socket typing claim on a room. */
  const addTypingSocket = (roomId: string, userId: string, socketId: string): void => {
    let byUser = typingRooms.get(roomId);
    if (!byUser) {
      byUser = new Map();
      typingRooms.set(roomId, byUser);
    }
    let sockets = byUser.get(userId);
    if (!sockets) {
      sockets = new Set();
      byUser.set(userId, sockets);
    }
    sockets.add(socketId);
  };

  /** Drops a socket typing claim. Returns true only if it was the user's last active socket in the room. */
  const removeTypingSocket = (roomId: string, userId: string, socketId: string): boolean => {
    const byUser = typingRooms.get(roomId);
    const sockets = byUser?.get(userId);
    if (!byUser || !sockets || !sockets.delete(socketId)) return false;
    if (sockets.size > 0) return false;
    byUser.delete(userId);
    if (byUser.size === 0) typingRooms.delete(roomId);
    return true;
  };

  /** True while this process holds any typing claim for the user in the room. */
  const heldLocally = (roomId: string, userId: string): boolean =>
    (typingRooms.get(roomId)?.get(userId)?.size ?? 0) > 0;

  /** Serialises store writes per room member; see `syncTyping`. */
  const syncTails = new Map<string, Promise<boolean>>();

  /** A sync that is queued but has not read the local state yet. */
  const syncPending = new Map<string, Promise<boolean>>();

  /**
   * Reconcile this instance's Redis claim with the local one, and report
   * whether the room should now be told the user stopped.
   *
   * Written as a reconciler rather than a claim/release pair because the two
   * would race: `typingRooms` is mutated before the round trip and a keystroke
   * arriving mid-flight can invert the answer, so the write has to be derived
   * from the local state at the moment it reaches Redis, not at the moment it
   * was requested. Per-key serialisation makes that state stable for the
   * duration of a round trip; the queue tail is the same shape as
   * `utils/redis.ts`'s `onChannel`, self-deleting so a room member that stops
   * typing leaves nothing behind.
   *
   * A call that finds a sync still waiting joins it instead of queueing
   * another: an unstarted sync will read exactly what this one would, so a
   * burst of keystrokes collapses into one write per round trip rather than
   * one per keystroke.
   */
  const syncTyping = (store: TypingStore, roomId: string, userId: string): Promise<boolean> => {
    const key = `${roomId}:${userId}`;
    const waiting = syncPending.get(key);
    if (waiting) return waiting;

    let self: Promise<boolean> | undefined;
    const run = async (): Promise<boolean> => {
      if (syncPending.get(key) === self) syncPending.delete(key);
      if (heldLocally(roomId, userId)) {
        await store.claim(roomId, userId);
        return false;
      }
      const result = await store.release(roomId, userId);
      // A claim taken while the release was in flight is the newer truth, and
      // the sync queued behind this one restores the field it just deleted.
      if (heldLocally(roomId, userId)) return false;
      // An unreachable Redis retracts as this instance always did, rather than
      // stranding an indicator nobody can clear. Same call as `presence.ts`.
      return !result.ok || result.value === 0;
    };

    const previous = syncTails.get(key) ?? Promise.resolve(false);
    const next = previous.then(run, run);
    self = next;
    syncTails.set(key, next);
    syncPending.set(key, next);
    void next.catch(() => undefined).then(() => {
      if (syncTails.get(key) === next) syncTails.delete(key);
      if (syncPending.get(key) === next) syncPending.delete(key);
    });
    return next;
  };

  // Tracks reserved handshake slots to prevent race conditions during connection setup.
  const reservedSessions = new WeakSet<object>();
  const reservationTimers = new WeakMap<object, ReturnType<typeof setTimeout>>();
  const reservationTtl = sessionReservationTtlMs();

  const settleReservation = (socket: object): boolean => {
    const timer = reservationTimers.get(socket);
    if (timer) {
      clearTimeout(timer);
      reservationTimers.delete(socket);
    }
    return reservedSessions.delete(socket);
  };

  const acquireSession = (userId: string): void => {
    sessionCounts.set(userId, (sessionCounts.get(userId) ?? 0) + 1);
  };
  const releaseSession = (userId: string): void => {
    const count = (sessionCounts.get(userId) ?? 1) - 1;
    if (count > 0) sessionCounts.set(userId, count);
    else sessionCounts.delete(userId);
  };

  // Reserve session slot during handshake middleware.
  if (typeof (io as unknown as { use?: unknown }).use === 'function') {
    io.use((socket, next) => {
      const userId = socket.data.user?.userId;
      if (!userId) {
        next(new Error('Authentication error'));
        return;
      }
      if ((sessionCounts.get(userId) ?? 0) >= sessionLimit) {
        next(new Error('Session limit reached'));
        return;
      }
      acquireSession(userId);
      reservedSessions.add(socket);
      const expiry = setTimeout(() => {
        reservationTimers.delete(socket);
        if (reservedSessions.delete(socket)) releaseSession(userId);
      }, reservationTtl);
      expiry.unref?.();
      reservationTimers.set(socket, expiry);
      next();
    });
  }

  io.on('connection', (socket) => {
    const userId = socket.data.user.userId;
    let disconnected = false;
    // A reservation that already expired has given its slot back, so this
    // connection has to take one of its own — and the limit has to be tested
    // again before it does. The middleware's check cannot stand in for it: it
    // passed against a count that included this handshake's own reservation,
    // and the slot has since been returned. Other connections may have taken
    // it in the meantime, so acquiring unconditionally here is what pushes a
    // user past `MAX_SESSIONS_PER_USER`.
    if (!settleReservation(socket)) {
      if ((sessionCounts.get(userId) ?? 0) >= sessionLimit) {
        socket.emit('error', { statusCode: 429, message: 'Session limit reached', code: 'SESSION_LIMIT' });
        socket.disconnect(true);
        return;
      }
      acquireSession(userId);
    }
    socket.join(`user_${userId}`);

    const typingTimerKey = (roomId: string): string => `${socket.id}:${roomId}`;

    const emitTyping = (roomId: string, isTyping: boolean) => {
      socket.to(`room_${roomId}`).emit('user_typing', { roomId, userId, isTyping });
    };

    /**
     * Retract this socket's claim on a room, telling the room only once no
     * instance claims it any more. `speak` gates the broadcast for the caller
     * that must not speak after teardown, and is read here rather than after
     * the round trip so a disconnect arriving mid-flight cannot swallow a
     * retraction the claim's owner was still entitled to make.
     *
     * Emitting after the socket is gone is safe: `socket.to(...)` captures the
     * adapter and the excluded socket id when it is called, and never reads the
     * socket again — which is what lets the retraction outlive an `await`.
     */
    const releaseClaim = (roomId: string, speak: boolean): void => {
      if (!removeTypingSocket(roomId, userId, socket.id)) return;
      const store = deps.typingStore;
      if (!store) {
        if (speak) emitTyping(roomId, false);
        return;
      }
      void syncTyping(store, roomId, userId).then(
        (retract) => {
          if (retract && speak) emitTyping(roomId, false);
        },
        () => {
          if (speak) emitTyping(roomId, false);
        },
      );
    };

    /**
     * Retract this socket's claim on a room. The single exit from typing:
     * explicit `isTyping: false`, the TTL, and disconnect all come through
     * here. Unlike the TTL timer this one still speaks after a disconnect —
     * losing the connection is exactly when the room has to be told.
     */
    const stopTyping = (roomId: string) => {
      const key = typingTimerKey(roomId);
      const claim = typingClaims.get(key);
      if (claim) clearTimeout(claim.expiry);
      typingClaims.delete(key);
      releaseClaim(roomId, true);
    };

    // Over a copy of the keys: `stopTyping` deletes from the map it walks.
    const clearTypingTimers = () => {
      for (const key of [...typingClaims.keys()]) {
        if (!key.startsWith(`${socket.id}:`)) continue;
        stopTyping(key.slice(socket.id.length + 1));
      }
    };

    // Restore room subscriptions from durable membership records.
    const restoreSubscriptions = deps.roomMemberRepository.findByUser
      ? deps.roomMemberRepository.findByUser(userId)
        .then((members) => Promise.all(
          members
            .filter((member) => member.role !== 'pending')
            .map(async (member) => {
              const join = async () => {
                const current = await deps.roomMemberRepository.findMember(member.roomId, userId);
                if (!current || current.role === 'pending') return;
                await Promise.resolve(socket.join(`room_${member.roomId}`));
              };
              if (deps.withRoomSubscriptionLock) {
                await deps.withRoomSubscriptionLock(userId, member.roomId, join);
              } else {
                await join();
              }
            }),
        ))
      : Promise.resolve();

    // Signal realtime ready only after all initial room rooms have been joined.
    void restoreSubscriptions.then(
      () => socket.emit('realtime_ready'),
      (error) => {
        console.error('Failed to restore room subscriptions:', error);
        if (typeof (socket as unknown as { disconnect?: (close?: boolean) => void }).disconnect === 'function') {
          socket.disconnect(true);
        }
      },
    );

    if (deps.friendRepository) {
      presence.trackUserConnection(io, userId, socket.id, deps.friendRepository).catch((err) => {
        console.error('trackUserConnection error:', err);
      });
    }

    socket.on('disconnect', () => {
      disconnected = true;
      clearTypingTimers();
      releaseSession(userId);

      if (deps.friendRepository) {
        presence.trackUserDisconnection(io, userId, socket.id, deps.friendRepository).catch((err) => {
          console.error('trackUserDisconnection error:', err);
        });
      }
    });

    socket.on('typing', async (payload) => {
      try {
        if (disconnected) return;
        if (
          !payload
          || typeof payload.roomId !== 'string'
          || payload.roomId.length === 0
          || payload.roomId.length > 128
          || typeof payload.isTyping !== 'boolean'
        ) {
          throw new ValidationError('Invalid typing payload');
        }
        const { roomId, isTyping } = payload;
        const key = typingTimerKey(roomId);
        const ttl = typingTtlMs();
        const prior = typingClaims.get(key);

        // Check room membership at most once per typing TTL window.
        let checkedAt = prior?.checkedAt ?? 0;
        const subscribed = socket.rooms?.has(`room_${roomId}`) === true;
        if (!subscribed || Date.now() - checkedAt >= ttl) {
          const member = await deps.roomMemberRepository.findMember(roomId, userId);
          if (disconnected) return;
          if (!member || member.role === 'pending') {
            throw new ForbiddenError('Not a member of this room');
          }
          checkedAt = Date.now();
        }

        if (!isTyping) {
          stopTyping(roomId);
          return;
        }

        // Arm or reset the typing expiration timer for this socket.
        const live = typingClaims.get(key);
        if (live) clearTimeout(live.expiry);
        const expiry: ReturnType<typeof setTimeout> = setTimeout(() => {
          if (typingClaims.get(key)?.expiry !== expiry) return;
          typingClaims.delete(key);
          releaseClaim(roomId, !disconnected);
        }, ttl);
        expiry.unref?.();
        typingClaims.set(key, { expiry, checkedAt });

        addTypingSocket(roomId, userId, socket.id);
        // The claim is refreshed in Redis without waiting for it: the heartbeat
        // below states local truth, which no cluster-wide count can change, and
        // `command` has no deadline of its own — a slow Redis would otherwise
        // stall every keystroke. Ordering against a later release is the
        // queue's job, not this call's.
        if (deps.typingStore) {
          void syncTyping(deps.typingStore, roomId, userId).catch(() => undefined);
        }
        // Broadcast typing heartbeat to the room.
        emitTyping(roomId, true);
      } catch (err) {
        socket.emit('error', mapErrorToApiShape(err));
      }
    });

  });
};
