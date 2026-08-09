import type { MessageWithSender } from '@shared/types';
import type { IMessageRepository } from '../models/IMessageRepository';
import type { IRoomMemberRepository } from '../models/IRoomMemberRepository';
import type { IRoomRepository } from '../models/IRoomRepository';
import { ForbiddenError, NotFoundError, ValidationError } from '../utils/AppError';
import {
  listMessagesSchema,
  recallMessageSchema,
  sendMessageSchema,
} from '../routes/messageSchemas';

const validationMessage = (issues: { message: string }[]) =>
  issues[0]?.message ?? 'Invalid message payload';

const EVERYONE_MENTION = 'everyone';

const parseMentionNames = (content: string): string[] => {
  const mentionMatches = [...content.matchAll(/@([^\s@]+)/g)];
  return Array.from(
    new Set(
      mentionMatches
        .map((match) => match[1].replace(/[.,!?;:]+$/, ''))
        .filter(Boolean),
    ),
  );
};

export const makeMessageService = (
  messageRepo: IMessageRepository,
  roomRepo: IRoomRepository,
  roomMemberRepo: IRoomMemberRepository,
  publish?: (roomId: string, event: 'new_message' | 'message_updated' | 'message_recalled' | 'read_update', payload: unknown) => void,
) => {
  const assertRoomMembership = async (userId: string, roomId: string) => {
    const room = await roomRepo.findById(roomId);
    if (!room) {
      throw new NotFoundError('room', roomId);
    }

    const member = await roomMemberRepo.findMember(roomId, userId);
    if (!member) {
      throw new ForbiddenError('User is not a member of this room');
    }
    if (member.role === 'pending') {
      throw new ForbiddenError('Pending members cannot access room messages');
    }

    return { room, member };
  };

  return {
    async sendMessage(
      userId: string,
      roomId: string,
      content: string,
      opts: { replyToId?: string; attachmentIds?: string[]; commandId?: string } = {},
    ): Promise<MessageWithSender> {
      const parsed = sendMessageSchema.safeParse({
        roomId,
        content,
        replyToId: opts.replyToId,
        attachmentIds: opts.attachmentIds,
      });
      if (!parsed.success) {
        throw new ValidationError(validationMessage(parsed.error.issues));
      }

      const { room, member } = await assertRoomMembership(userId, parsed.data.roomId);
      if (room.isArchived) {
        throw new ForbiddenError('This room is archived');
      }
      if (room.isReadonly) {
        throw new ForbiddenError('This room is read-only');
      }
      if (member.isMuted) {
        throw new ForbiddenError('Muted members cannot send messages');
      }
      const mentionNames = parseMentionNames(parsed.data.content);
      const mentionsEveryone = mentionNames.some(
        (name) => name.toLowerCase() === EVERYONE_MENTION,
      );
      const directMentionNames = mentionNames.filter(
        (name) => name.toLowerCase() !== EVERYONE_MENTION,
      );

      const directMentionedUserIds = directMentionNames.length > 0
        ? await roomMemberRepo.resolveMentions(parsed.data.roomId, directMentionNames)
        : [];
      const everyoneMentionedUserIds = mentionsEveryone
        ? (await roomMemberRepo.findByRoom(parsed.data.roomId))
            .filter((roomMember) => roomMember.role !== 'pending' && roomMember.userId !== userId)
            .map((roomMember) => roomMember.userId)
        : [];
      const mentionedUserIds = Array.from(
        new Set([...directMentionedUserIds, ...everyoneMentionedUserIds]),
      );

      const messageData: Parameters<IMessageRepository['create']>[0] = {
        roomId: parsed.data.roomId,
        senderId: userId,
        content: parsed.data.content,
      };
      if (parsed.data.replyToId) {
        messageData.replyToId = parsed.data.replyToId;
      }
      if (mentionedUserIds.length > 0) {
        messageData.mentions = mentionedUserIds;
      }
      if (parsed.data.attachmentIds && parsed.data.attachmentIds.length > 0) {
        messageData.attachmentIds = parsed.data.attachmentIds;
      }
      if (opts.commandId) {
        messageData.commandId = opts.commandId;
      }

      const message = await messageRepo.create(messageData);
      if (roomMemberRepo.markRead) {
        await roomMemberRepo.markRead(parsed.data.roomId, userId, message.messageId);
      } else {
        await roomMemberRepo.update(parsed.data.roomId, userId, { lastReadId: message.messageId });
      }
      publish?.(parsed.data.roomId, 'new_message', message);
      return message;
    },

    async listForRoom(
      userId: string,
      roomId: string,
      opts: { beforeId?: string; limit?: number } = {},
    ): Promise<MessageWithSender[]> {
      const parsed = listMessagesSchema.safeParse({
        roomId,
        beforeId: opts.beforeId,
        limit: opts.limit ?? 50,
      });
      if (!parsed.success) {
        throw new ValidationError(validationMessage(parsed.error.issues));
      }

      const { room, member } = await assertRoomMembership(userId, parsed.data.roomId);

      return messageRepo.findByRoom(parsed.data.roomId, {
        beforeId: parsed.data.beforeId,
        limit: parsed.data.limit,
        after: room.viewHistory ? undefined : member.joinTime,
      });
    },

    async recallMessage(
      userId: string,
      roomId: string,
      messageId: string,
      opts: { expectedRevision?: number; commandId?: string } = {},
    ): Promise<MessageWithSender> {
      const parsed = recallMessageSchema.safeParse({ roomId, messageId });
      if (!parsed.success) {
        throw new ValidationError(validationMessage(parsed.error.issues));
      }

      const { member } = await assertRoomMembership(userId, parsed.data.roomId);

      const existing = await messageRepo.findById(parsed.data.messageId);
      if (!existing || existing.roomId !== parsed.data.roomId) {
        throw new NotFoundError('message', parsed.data.messageId);
      }

      if (existing.senderId !== userId) {
        if (member.role !== 'owner' && member.role !== 'admin') {
          throw new ForbiddenError('Only the original sender or an admin can recall this message');
        }

        if (member.role === 'admin' && existing.senderId) {
          const senderMember = await roomMemberRepo.findMember(parsed.data.roomId, existing.senderId);
          if (senderMember && (senderMember.role === 'owner' || senderMember.role === 'admin')) {
            throw new ForbiddenError('Admins cannot recall messages from the room owner or other admins');
          }
        }
      }

      const recalled = opts.expectedRevision !== undefined || opts.commandId !== undefined
        ? await messageRepo.markRecalled(parsed.data.messageId, opts.expectedRevision, opts.commandId, userId)
        : await messageRepo.markRecalled(parsed.data.messageId);
      publish?.(parsed.data.roomId, 'message_recalled', {
        messageId: recalled.messageId,
        messageSequence: recalled.messageSequence,
        changeSequence: recalled.changeSequence,
        revision: recalled.revision,
      });
      return recalled;
    },

    async updateMessage(
      userId: string,
      roomId: string,
      messageId: string,
      content: string,
      opts: { expectedRevision?: number; commandId?: string } = {},
    ): Promise<MessageWithSender> {
      const parsed = sendMessageSchema.safeParse({ roomId, content });
      if (!parsed.success) {
        throw new ValidationError(validationMessage(parsed.error.issues));
      }

      const { room, member } = await assertRoomMembership(userId, roomId);
      if (room.isArchived) {
        throw new ForbiddenError('This room is archived');
      }
      if (room.isReadonly) {
        throw new ForbiddenError('This room is read-only');
      }
      if (member.isMuted) {
        throw new ForbiddenError('Muted members cannot update messages');
      }

      const existing = await messageRepo.findById(messageId);
      if (!existing || existing.roomId !== roomId) {
        throw new NotFoundError('message', messageId);
      }

      if (existing.senderId !== userId) {
        throw new ForbiddenError('Only the original sender can edit this message');
      }

      if (existing.isRecalled) {
        throw new ValidationError('Cannot edit a recalled message');
      }

      const mentionNames = parseMentionNames(parsed.data.content);
      const mentionsEveryone = mentionNames.some(
        (name) => name.toLowerCase() === EVERYONE_MENTION,
      );
      const directMentionNames = mentionNames.filter(
        (name) => name.toLowerCase() !== EVERYONE_MENTION,
      );

      const directMentionedUserIds = directMentionNames.length > 0
        ? await roomMemberRepo.resolveMentions(roomId, directMentionNames)
        : [];
      const everyoneMentionedUserIds = mentionsEveryone
        ? (await roomMemberRepo.findByRoom(roomId))
            .filter((roomMember) => roomMember.role !== 'pending' && roomMember.userId !== userId)
            .map((roomMember) => roomMember.userId)
        : [];
      const mentionedUserIds = Array.from(
        new Set([...directMentionedUserIds, ...everyoneMentionedUserIds]),
      );

      const updated = opts.expectedRevision !== undefined || opts.commandId !== undefined
        ? await messageRepo.update(messageId, parsed.data.content, mentionedUserIds, opts.expectedRevision, opts.commandId, userId)
        : await messageRepo.update(messageId, parsed.data.content, mentionedUserIds);
      publish?.(roomId, 'message_updated', updated);
      return updated;
    },

    async markRead(userId: string, roomId: string, messageId: string, commandId?: string) {
      const { room, member } = await assertRoomMembership(userId, roomId);
      const message = await messageRepo.findById(messageId);
      if (!message || message.roomId !== roomId) {
        throw new NotFoundError('message', messageId);
      }
      const sequence = message.messageSequence ?? 0;
      const visible = room.viewHistory
        || (sequence > 0 && sequence > (member.joinBoundary ?? 0))
        || (sequence === 0 && message.sentAt >= member.joinTime);
      if (!visible) throw new ForbiddenError('Message is outside the room visibility boundary');
      if (roomMemberRepo.markRead) {
        const member = await roomMemberRepo.markRead(roomId, userId, messageId, commandId);
        publish?.(roomId, 'read_update', {
          roomId,
          userId,
          messageId,
          readPosition: member.readPosition,
        });
        return member;
      }

      const updatedMember = await roomMemberRepo.update(roomId, userId, { lastReadId: messageId });
      publish?.(roomId, 'read_update', { roomId, userId, messageId });
      return updatedMember;
    },

    async sync(userId: string, cursor: number, limit: number) {
      if (!messageRepo.findChangesForUser) {
        throw new ValidationError('Realtime sync is not available');
      }
      return messageRepo.findChangesForUser(userId, cursor, limit);
    },
  };
};
