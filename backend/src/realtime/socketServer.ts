import type { ApiError, MessageWithSender } from '@shared/types';
import { AppError, ForbiddenError, NotFoundError, ValidationError } from '../errors/AppError';
import type { IMessageRepository } from '../repositories/IMessageRepository';
import type { IRoomMemberRepository } from '../repositories/IRoomMemberRepository';
import type { ChatServer } from './authSocket';
import { trackUserConnection, trackUserDisconnection } from './presence';

interface MessageService {
  sendMessage(
    userId: string,
    roomId: string,
    content: string,
    opts?: { replyToId?: string; attachmentIds?: string[] },
  ): Promise<MessageWithSender>;
  recallMessage(userId: string, roomId: string, messageId: string): Promise<MessageWithSender>;
  updateMessage(userId: string, roomId: string, messageId: string, content: string): Promise<MessageWithSender>;
}

interface SocketDeps {
  messageService: MessageService;
  messageRepository: Pick<IMessageRepository, 'findById'>;
  roomMemberRepository: Pick<IRoomMemberRepository, 'update' | 'findMember'>;
  friendRepository?: { getFriends(userId: string): Promise<any[]> };
}

import { mapErrorToApiShape } from '../errors/mapError';

export const attachSockets = (io: ChatServer, deps: SocketDeps): void => {
  io.on('connection', (socket) => {
    const userId = socket.data.user.userId;

    socket.join(`user_${userId}`);

    if (deps.friendRepository) {
      trackUserConnection(io, userId, socket.id, deps.friendRepository).catch((err) => {
        console.error('trackUserConnection error:', err);
      });
    }

    socket.on('disconnect', () => {
      if (deps.friendRepository) {
        trackUserDisconnection(io, userId, socket.id, deps.friendRepository).catch((err) => {
          console.error('trackUserDisconnection error:', err);
        });
      }
    });

    socket.on('join_room', async ({ roomId }) => {
      try {
        const member = await deps.roomMemberRepository.findMember(roomId, userId);
        if (!member) {
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

    socket.on('send_message', async ({ roomId, content, replyTo, attachmentIds }) => {
      try {
        const message = await deps.messageService.sendMessage(userId, roomId, content, {
          replyToId: replyTo,
          attachmentIds,
        });
        io.to(`room_${roomId}`).emit('new_message', message);
        socket.to(`room_${roomId}`).emit('read_update', { roomId, userId, messageId: message.messageId });
      } catch (err) {
        socket.emit('error', mapErrorToApiShape(err));
      }
    });

    socket.on('recall_message', async ({ messageId }) => {
      try {
        const existing = await deps.messageRepository.findById(messageId);
        if (!existing) {
          throw new NotFoundError('message', messageId);
        }

        const recalled = await deps.messageService.recallMessage(userId, existing.roomId, messageId);
        io.to(`room_${existing.roomId}`).emit('message_recalled', {
          messageId: recalled.messageId,
        });
      } catch (err) {
        socket.emit('error', mapErrorToApiShape(err));
      }
    });

    socket.on('update_message', async ({ roomId, messageId, content }) => {
      try {
        const updated = await deps.messageService.updateMessage(userId, roomId, messageId, content);
        io.to(`room_${roomId}`).emit('message_updated', updated);
      } catch (err) {
        socket.emit('error', mapErrorToApiShape(err));
      }
    });

    socket.on('typing', ({ roomId, isTyping }) => {
      socket.to(`room_${roomId}`).emit('user_typing', { roomId, userId, isTyping });
    });

    socket.on('read_receipt', async ({ roomId, messageId }) => {
      try {
        const msg = await deps.messageRepository.findById(messageId);
        if (!msg || msg.roomId !== roomId) {
          throw new ValidationError('Invalid messageId for this room');
        }
        await deps.roomMemberRepository.update(roomId, userId, { lastReadId: messageId });
        socket.to(`room_${roomId}`).emit('read_update', { roomId, userId, messageId });
      } catch (err) {
        socket.emit('error', mapErrorToApiShape(err));
      }
    });
  });
};
