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
  /** Optional injected presence tracker (defaults to process singleton). */
  presence?: Pick<PresenceTracker, 'trackUserConnection' | 'trackUserDisconnection'>;
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
          if (removeTypingSocket(roomId, userId, socket.id) && !disconnected) {
            emitTyping(roomId, false);
          }
        }, ttl);
        expiry.unref?.();
        typingClaims.set(key, { expiry, checkedAt });

        addTypingSocket(roomId, userId, socket.id);
        // Broadcast typing heartbeat to the room.
        emitTyping(roomId, true);
      } catch (err) {
        socket.emit('error', mapErrorToApiShape(err));
      }
    });

  });
};
