import type { FriendResponse } from '@shared/types';
import { ForbiddenError, ValidationError } from '../utils/AppError';
import type { IRoomMemberRepository } from '../models/IRoomMemberRepository';
import type { ChatServer } from './authSocket';
import { trackUserConnection, trackUserDisconnection } from './presence';
import { mapErrorToApiShape } from '../utils/mapError';

interface SocketDeps {
  roomMemberRepository: Pick<IRoomMemberRepository, 'findMember' | 'findByUser'>;
  friendRepository?: { getFriends(userId: string): Promise<FriendResponse[]> };
  withRoomSubscriptionLock?: <T>(
    userId: string,
    roomId: string,
    operation: () => Promise<T> | T,
  ) => Promise<T>;
}

const maxSessionsPerUser = (): number => {
  const configured = Number(process.env.MAX_SESSIONS_PER_USER ?? 5);
  return Number.isInteger(configured) && configured > 0 ? configured : 5;
};

const typingTtlMs = (): number => {
  const configured = Number(process.env.TYPING_TTL_MS ?? 3_000);
  return Number.isFinite(configured) && configured > 0 ? configured : 3_000;
};

/**
 * Attach only the ephemeral realtime surface. Durable commands deliberately
 * have no Socket.IO listeners: REST owns idempotency, optimistic concurrency,
 * authorization and the transaction that creates the durable event.
 */
export const attachSockets = (io: ChatServer, deps: SocketDeps): void => {
  const sessionLimit = maxSessionsPerUser();
  const sessionCounts = new Map<string, number>();
  const typingTimers = new Map<string, ReturnType<typeof setTimeout>>();

  // The auth middleware runs first and stores socket.data.user. Test doubles
  // without `use` still exercise the connection handlers below.
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
      next();
    });
  }

  io.on('connection', (socket) => {
    const userId = socket.data.user.userId;
    let disconnected = false;
    sessionCounts.set(userId, (sessionCounts.get(userId) ?? 0) + 1);
    socket.join(`user_${userId}`);

    const clearTypingTimers = () => {
      for (const [key, timer] of typingTimers) {
        if (key.startsWith(`${socket.id}:`)) {
          const roomId = key.slice(socket.id.length + 1);
          clearTimeout(timer);
          typingTimers.delete(key);
          socket.to(`room_${roomId}`).emit('user_typing', {
            roomId,
            userId,
            isTyping: false,
          });
        }
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
      trackUserConnection(io, userId, socket.id, deps.friendRepository).catch((err) => {
        console.error('trackUserConnection error:', err);
      });
    }

    socket.on('disconnect', () => {
      disconnected = true;
      clearTypingTimers();
      const count = (sessionCounts.get(userId) ?? 1) - 1;
      if (count > 0) sessionCounts.set(userId, count);
      else sessionCounts.delete(userId);

      if (deps.friendRepository) {
        trackUserDisconnection(io, userId, socket.id, deps.friendRepository).catch((err) => {
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
        const member = await deps.roomMemberRepository.findMember(roomId, userId);
        if (disconnected) return;
        if (!member || member.role === 'pending') {
          throw new ForbiddenError('Not a member of this room');
        }

        const key = `${socket.id}:${roomId}`;
        const prior = typingTimers.get(key);
        if (prior) clearTimeout(prior);

        socket.to(`room_${roomId}`).emit('user_typing', { roomId, userId, isTyping });
        if (isTyping) {
          typingTimers.set(key, setTimeout(() => {
            typingTimers.delete(key);
            if (disconnected) return;
            socket.to(`room_${roomId}`).emit('user_typing', {
              roomId,
              userId,
              isTyping: false,
            });
          }, typingTtlMs()));
        } else {
          typingTimers.delete(key);
        }
      } catch (err) {
        socket.emit('error', mapErrorToApiShape(err));
      }
    });

  });
};
