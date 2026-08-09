import type { FriendResponse } from '@shared/types';
import { ForbiddenError, NotFoundError, ValidationError } from '../utils/AppError';
import type { IRoomMemberRepository } from '../models/IRoomMemberRepository';
import type { ChatServer } from './authSocket';
import { trackUserConnection, trackUserDisconnection } from './presence';
import { mapErrorToApiShape } from '../utils/mapError';

interface SocketDeps {
  /** @deprecated Durable commands are REST-only; retained for old test wiring. */
  messageService?: unknown;
  /** @deprecated Durable commands are REST-only; retained for old test wiring. */
  messageRepository?: unknown;
  roomMemberRepository: Pick<IRoomMemberRepository, 'findMember' | 'findByUser' | 'update'>;
  friendRepository?: { getFriends(userId: string): Promise<FriendResponse[]> };
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
    sessionCounts.set(userId, (sessionCounts.get(userId) ?? 0) + 1);
    socket.join(`user_${userId}`);

    const clearTypingTimers = () => {
      for (const [key, timer] of typingTimers) {
        if (key.startsWith(`${socket.id}:`)) {
          clearTimeout(timer);
          typingTimers.delete(key);
        }
      }
    };

    // Subscriptions are derived from durable membership at connection time.
    // A pending member is intentionally excluded, and room revocation later
    // removes all sessions through the publisher boundary.
    if (deps.roomMemberRepository.findByUser) {
      deps.roomMemberRepository.findByUser(userId)
        .then((members) => Promise.all(
          members
            .filter((member) => member.role !== 'pending')
            .map((member) => socket.join(`room_${member.roomId}`)),
        ))
        .catch((error) => console.error('Failed to restore room subscriptions:', error));
    }

    if (deps.friendRepository) {
      trackUserConnection(io, userId, socket.id, deps.friendRepository).catch((err) => {
        console.error('trackUserConnection error:', err);
      });
    }

    socket.on('disconnect', () => {
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

    // Kept as an idempotent membership check for older clients. It cannot
    // expand authorization and is not used by the current frontend.
    socket.on('join_room', async ({ roomId }) => {
      try {
        const member = await deps.roomMemberRepository.findMember(roomId, userId);
        if (!member || member.role === 'pending') {
          throw new ForbiddenError('Not a member of this room');
        }
        socket.join(`room_${roomId}`);
      } catch (err) {
        socket.emit('error', mapErrorToApiShape(err));
      }
    });

    socket.on('leave_room', ({ roomId }) => {
      socket.leave(`room_${roomId}`);
    });

    socket.on('typing', async ({ roomId, isTyping }) => {
      try {
        const member = await deps.roomMemberRepository.findMember(roomId, userId);
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

    // Compatibility adapter for isolated legacy tests/embedded consumers that
    // explicitly inject the old command services. The production composition
    // root does not provide these dependencies, so its Socket.IO surface has
    // no durable write listeners.
    if (deps.messageService && deps.messageRepository) {
      const legacyService = deps.messageService as {
        sendMessage(userId: string, roomId: string, content: string, opts: { replyToId?: string; attachmentIds?: string[] }): Promise<unknown>;
        recallMessage(userId: string, roomId: string, messageId: string): Promise<{ messageId: string }>;
        updateMessage?(userId: string, roomId: string, messageId: string, content: string): Promise<unknown>;
      };
      const legacyRepository = deps.messageRepository as {
        findById(messageId: string): Promise<{ roomId: string } | null>;
      };

      socket.on('send_message', async ({ roomId, content, replyTo, attachmentIds }) => {
        try {
          const message = await legacyService.sendMessage(userId, roomId, content, {
            replyToId: replyTo,
            attachmentIds,
          });
          io.to(`room_${roomId}`).emit('new_message', message as never);
        } catch (err) {
          socket.emit('error', mapErrorToApiShape(err));
        }
      });

      socket.on('recall_message', async ({ messageId }) => {
        try {
          const existing = await legacyRepository.findById(messageId);
          if (!existing) throw new NotFoundError('message', messageId);
          const recalled = await legacyService.recallMessage(userId, existing.roomId, messageId);
          io.to(`room_${existing.roomId}`).emit('message_recalled', { messageId: recalled.messageId });
        } catch (err) {
          socket.emit('error', mapErrorToApiShape(err));
        }
      });

      socket.on('update_message', async ({ roomId, messageId, content }) => {
        try {
          const updated = await legacyService.updateMessage?.(userId, roomId, messageId, content);
          io.to(`room_${roomId}`).emit('message_updated', updated as never);
        } catch (err) {
          socket.emit('error', mapErrorToApiShape(err));
        }
      });

      socket.on('read_receipt', async ({ roomId, messageId }) => {
        try {
          const message = await legacyRepository.findById(messageId);
          if (!message || message.roomId !== roomId) {
            throw new ValidationError('Invalid messageId for this room');
          }
          await deps.roomMemberRepository.update(roomId, userId, { lastReadId: messageId });
          socket.to(`room_${roomId}`).emit('read_update', { roomId, userId, messageId });
        } catch (err) {
          socket.emit('error', mapErrorToApiShape(err));
        }
      });

      // Preserve the old unit/integration harness behaviour for injected
      // legacy dependencies. Production never enters this branch.
      socket.on('typing', ({ roomId, isTyping }) => {
        socket.to(`room_${roomId}`).emit('user_typing', { roomId, userId, isTyping });
      });
    }
  });
};
