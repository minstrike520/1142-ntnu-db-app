import type { FriendResponse } from '@shared/types';
import { ForbiddenError, ValidationError } from '../utils/AppError';
import type { IRoomMemberRepository } from '../models/IRoomMemberRepository';
import type { ChatServer } from './authSocket';
import { trackUserConnection, trackUserDisconnection, type PresenceTracker } from './presence';
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
  /**
   * The presence tracker, defaulting to the process-wide one.
   *
   * Injected so a test can watch these two calls without `mock.module`, which
   * would replace the module for every later test file in the same process.
   * See backend/tests/CLAUDE.md.
   */
  presence?: Pick<PresenceTracker, 'trackUserConnection' | 'trackUserDisconnection'>;
}

const maxSessionsPerUser = (): number => env().realtime.maxSessionsPerUser;

const typingTtlMs = (): number => env().realtime.typingTtlMs;

/**
 * How long a handshake may hold its reserved session slot before the slot is
 * assumed abandoned. Socket.IO defers the rest of the connection setup past
 * the middleware, so a transport that dies in that window never reaches the
 * `connection` handler and never registers the `disconnect` listener that
 * would return the slot. Without an expiry those slots accumulate until the
 * user can no longer connect at all.
 */
const sessionReservationTtlMs = (): number => env().realtime.sessionReservationTtlMs;

/**
 * Attach only the ephemeral realtime surface. Durable commands deliberately
 * have no Socket.IO listeners: REST owns idempotency, optimistic concurrency,
 * authorization and the transaction that creates the durable event.
 */
export const attachSockets = (io: ChatServer, deps: SocketDeps): void => {
  const presence = deps.presence ?? { trackUserConnection, trackUserDisconnection };
  const sessionLimit = maxSessionsPerUser();
  const sessionCounts = new Map<string, number>();
  /**
   * One live typing claim per socket per room: the expiry that retracts it if
   * the socket goes silent, and when this socket's membership of that room was
   * last verified.
   */
  const typingClaims = new Map<string, { expiry: ReturnType<typeof setTimeout>; checkedAt: number }>();
  /**
   * Which sockets currently claim each `(room, user)` pair.
   *
   * `user_typing` is a statement about a *user*, but a user has as many sockets
   * as open tabs, so the claim has to be aggregated before it can be broadcast.
   * Keyed per socket — which is what this replaced — a second tab sending
   * `isTyping: false`, or simply closing, retracts a claim the first tab is
   * still refreshing, and every other member sees the indicator disappear while
   * the user is still typing.
   *
   * Nested maps rather than one map under a composite key: `roomId` and `userId`
   * are both opaque strings from outside this process, and there is no separator
   * they cannot both contain.
   *
   * Process-local on purpose. Aggregating across instances needs the events
   * themselves to cross first — `realtime/publisher.ts` is single-process, and
   * closing that is the event bus's job (#475/#476), not this module's.
   */
  const typingRooms = new Map<string, Map<string, Set<string>>>();

  /** Record a socket's claim. True only when it is the user's first in the room. */
  const addTypingSocket = (roomId: string, userId: string, socketId: string): boolean => {
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
    // Whether the set was empty *before* this socket joined it — not whether it
    // now holds one. A socket refreshing its own claim leaves the size at one,
    // so testing the size afterwards reports every keystroke as a fresh claim.
    const claimed = sockets.size === 0;
    sockets.add(socketId);
    return claimed;
  };

  /**
   * Drop a socket's claim. True only when it was the user's last in the room.
   *
   * Empty containers are deleted rather than left behind: a long-lived process
   * would otherwise accumulate one entry per room anyone has ever typed in.
   */
  const removeTypingSocket = (roomId: string, userId: string, socketId: string): boolean => {
    const byUser = typingRooms.get(roomId);
    const sockets = byUser?.get(userId);
    if (!byUser || !sockets || !sockets.delete(socketId)) return false;
    if (sockets.size > 0) return false;
    byUser.delete(userId);
    if (byUser.size === 0) typingRooms.delete(roomId);
    return true;
  };
  // Handshakes whose slot was already reserved by the middleware below, so the
  // connection handler does not count the same session twice. Each reservation
  // is a lease: if the connection never arrives, the timer returns the slot.
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

  // The auth middleware runs first and stores socket.data.user. Test doubles
  // without `use` still exercise the connection handlers below.
  if (typeof (io as unknown as { use?: unknown }).use === 'function') {
    io.use((socket, next) => {
      const userId = socket.data.user?.userId;
      if (!userId) {
        next(new Error('Authentication error'));
        return;
      }
      // Check and reserve in the same synchronous step. Counting only once the
      // connection handler runs would let every concurrent handshake read the
      // same pre-connection total and pass a limit that is already exhausted.
      if ((sessionCounts.get(userId) ?? 0) >= sessionLimit) {
        next(new Error('Session limit reached'));
        return;
      }
      acquireSession(userId);
      reservedSessions.add(socket);
      const expiry = setTimeout(() => {
        reservationTimers.delete(socket);
        // Only release when the connection handler has not already claimed
        // this reservation, otherwise a live session would lose its slot.
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
     * Retract this socket's claim on a room, telling the room only if it was the
     * user's last one. The single exit from typing: explicit `isTyping: false`,
     * the TTL, and disconnect all come through here.
     */
    const stopTyping = (roomId: string) => {
      const key = typingTimerKey(roomId);
      const claim = typingClaims.get(key);
      if (claim) clearTimeout(claim.expiry);
      typingClaims.delete(key);
      if (removeTypingSocket(roomId, userId, socket.id)) emitTyping(roomId, false);
    };

    // Over a copy of the keys: `stopTyping` deletes from the map it walks.
    const clearTypingTimers = () => {
      for (const key of [...typingClaims.keys()]) {
        if (!key.startsWith(`${socket.id}:`)) continue;
        stopTyping(key.slice(socket.id.length + 1));
      }
    };

    // Subscriptions are derived from durable membership at connection time.
    // A pending member is intentionally excluded, and room revocation later
    // removes all sessions through the publisher boundary.
    const restoreSubscriptions = deps.roomMemberRepository.findByUser
      ? deps.roomMemberRepository.findByUser(userId)
        .then((members) => Promise.all(
          members
            .filter((member) => member.role !== 'pending')
            .map(async (member) => {
              const join = async () => {
                // findByUser is only a candidate list. Re-check inside the
                // same lock used by membership revocation so a stale query
                // cannot re-add a socket after socketsLeave has completed.
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

    // The client must not begin its durable sync until every initial room
    // subscription has been derived. This closes the snapshot/subscribe gap:
    // changes committed after sync starts are either received live or appear
    // in the next sync, rather than falling between both paths.
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

        // Membership is re-checked once per TTL rather than once per keystroke.
        // The client sends `typing` on every input change, and `findMember` is a
        // three-table join with a correlated `EXISTS` over `blocks`, so the old
        // per-event check put that query on every character typed.
        //
        // Bounded by the TTL rather than by "this socket has a live claim":
        // a claim is refreshed by each keystroke, so trusting a live one would
        // let a member whose access was revoked hold the indicator open for as
        // long as they keep typing. Revocation drops the socket from the room
        // through the publisher, and this closes the window behind it.
        let checkedAt = prior?.checkedAt ?? 0;
        if (Date.now() - checkedAt >= ttl) {
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

        // Re-read rather than reuse `prior`, which was captured before the
        // membership query: a concurrent event may have armed a newer expiry in
        // the meantime, and that is the one this replaces.
        const live = typingClaims.get(key);
        if (live) clearTimeout(live.expiry);
        const expiry: ReturnType<typeof setTimeout> = setTimeout(() => {
          // Two `typing` events can be in flight at once — each awaits the
          // membership query — and both would arm an expiry. Only the one the
          // map still holds may retract the claim; a superseded timer firing
          // would stop a user who is still typing.
          if (typingClaims.get(key)?.expiry !== expiry) return;
          typingClaims.delete(key);
          // Cleared before the disconnect test, never after: a claim left in
          // the aggregate is one the room can never be told about again.
          if (removeTypingSocket(roomId, userId, socket.id) && !disconnected) {
            emitTyping(roomId, false);
          }
        }, ttl);
        // The reservation timer above already does this; an unreffed timer here
        // would hold `bun test` and a draining container open for a full TTL.
        expiry.unref?.();
        typingClaims.set(key, { expiry, checkedAt });

        // Only the edge is broadcast. A second tab joining a claim the room has
        // already been told about is not news, and re-sending `true` per
        // keystroke made the indicator a per-keystroke fan-out to every member.
        if (addTypingSocket(roomId, userId, socket.id)) emitTyping(roomId, true);
      } catch (err) {
        socket.emit('error', mapErrorToApiShape(err));
      }
    });

  });
};
