import type { Message, MessageChange, MessageWithSender } from '@shared/types';

export interface IMessageRepository {
  findById(messageId: string): Promise<Message | null>;
  findByRoom(roomId: string, opts: { beforeId?: string; limit: number; after?: Date }): Promise<MessageWithSender[]>;
  create(data: Pick<Message, 'roomId' | 'senderId' | 'content' | 'replyToId'> & { mentions?: string[], attachmentIds?: string[], commandId?: string }): Promise<MessageWithSender>;
  markRecalled(messageId: string, expectedRevision?: number, commandId?: string, actorId?: string): Promise<MessageWithSender>;
  update(messageId: string, content: string, mentions?: string[], expectedRevision?: number, commandId?: string, actorId?: string): Promise<MessageWithSender>;
  findChangesForUser?(userId: string, cursor: number, limit: number): Promise<MessageChange[]>;
}
