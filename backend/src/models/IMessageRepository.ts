import type { Message, MessageWithSender } from '@shared/types';

export interface IMessageRepository {
  findById(messageId: string): Promise<Message | null>;
  findByRoom(roomId: string, opts: { beforeId?: string; limit: number; after?: Date }): Promise<MessageWithSender[]>;
  create(data: Pick<Message, 'roomId' | 'senderId' | 'content' | 'replyToId'> & { mentions?: string[], attachmentIds?: string[] }): Promise<MessageWithSender>;
  markRecalled(messageId: string): Promise<MessageWithSender>;
  update(messageId: string, content: string, mentions?: string[]): Promise<MessageWithSender>;
}
