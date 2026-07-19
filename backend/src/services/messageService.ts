import type { MessageWithSender } from '@shared/types';
import type { IMessageRepository } from '../repositories/IMessageRepository';
import type { IRoomMemberRepository } from '../repositories/IRoomMemberRepository';
import type { IRoomRepository } from '../repositories/IRoomRepository';
import { ForbiddenError, NotFoundError, ValidationError } from '../errors/AppError';
import {
  listMessagesSchema,
  recallMessageSchema,
  sendMessageSchema,
} from '../validators/messageSchemas';

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
      opts: { replyToId?: string; attachmentIds?: string[] } = {},
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

      const message = await messageRepo.create(messageData);
      await roomMemberRepo.update(parsed.data.roomId, userId, { lastReadId: message.messageId });
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

      return messageRepo.markRecalled(parsed.data.messageId);
    },

    async updateMessage(
      userId: string,
      roomId: string,
      messageId: string,
      content: string,
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

      return messageRepo.update(messageId, parsed.data.content, mentionedUserIds);
    },
  };
};
