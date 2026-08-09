import type { Message, MessageWithSender } from '@shared/types';

export interface IMessageRepository {
  findById(messageId: string): Promise<Message | null>;
  findByRoom(roomId: string, opts: { beforeId?: string; limit: number; afterSeq?: number }): Promise<MessageWithSender[]>;
  findBySenderCommandId(senderId: string, clientCommandId: string): Promise<MessageWithSender | null>;
  create(data: Pick<Message, 'roomId' | 'senderId' | 'content' | 'replyToId'> & { mentions?: string[], attachmentIds?: string[], clientCommandId?: string }): Promise<MessageWithSender>;
  markRecalled(messageId: string): Promise<MessageWithSender>;
  update(messageId: string, content: string, mentions?: string[]): Promise<MessageWithSender>;
}
