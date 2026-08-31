import { SQL } from 'bun';
import defaultSql from './db';
import type { Message, MessageChange, MessageWithSender } from '@shared/types';
import type { IMessageRepository } from './IMessageRepository';
import { MessageChangeQueries } from './message/messageChangeQueries';
import { MessageCommands } from './message/messageCommands';
import { MessageQueries } from './message/messageQueries';

export type {
  AttachmentRow,
  AttachmentSnapshotRow,
  MessageChangeRow,
  MessageRow,
  MessageSnapshotRow,
  MessageWithSenderRow,
} from './message/mappers';

/**
 * Stable repository façade. Consumers keep depending on IMessageRepository;
 * storage concerns are composed behind this class by responsibility.
 */
export class MessageRepository implements IMessageRepository {
  private readonly queries: MessageQueries;
  private readonly changes: MessageChangeQueries;
  private readonly commands: MessageCommands;

  constructor(sql: SQL = defaultSql) {
    this.queries = new MessageQueries(sql);
    this.changes = new MessageChangeQueries(sql, this.queries);
    this.commands = new MessageCommands(sql, this.queries, this.changes);
  }

  findById(messageId: string): Promise<Message | null> {
    return this.queries.findById(messageId);
  }

  findByRoom(
    roomId: string,
    opts: { beforeId?: string; limit: number; after?: Date; afterSequence?: number },
  ): Promise<MessageWithSender[]> {
    return this.queries.findByRoom(roomId, opts);
  }

  create(data: Pick<Message, 'roomId' | 'senderId' | 'content' | 'replyToId'> & {
    mentions?: string[];
    attachmentIds?: string[];
    commandId?: string;
  }): Promise<MessageWithSender> {
    return this.commands.create(data);
  }

  markRecalled(
    messageId: string,
    expectedRevision?: number,
    commandId?: string,
    actorId?: string,
  ): Promise<MessageWithSender> {
    return this.commands.markRecalled(messageId, expectedRevision, commandId, actorId);
  }

  update(
    messageId: string,
    content: string,
    mentions?: string[],
    expectedRevision?: number,
    commandId?: string,
    actorId?: string,
  ): Promise<MessageWithSender> {
    return this.commands.update(messageId, content, mentions, expectedRevision, commandId, actorId);
  }

  findChangesForUser(userId: string, cursor: number, limit: number): Promise<MessageChange[]> {
    return this.changes.findChangesForUser(userId, cursor, limit);
  }
}
