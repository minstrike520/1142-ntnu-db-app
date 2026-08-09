import { SQL } from "bun";
import defaultSql from "./db";
import type { Attachment, Message, MessageWithSender } from '@shared/types';
import type { IMessageRepository } from './IMessageRepository';
import { ValidationError } from '../utils/AppError';

const PG_UNIQUE_VIOLATION = '23505';

/** Bun's SQL driver reports the SQLSTATE in `errno`; node-pg reports it in `code`. */
function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const { code, errno } = err as { code?: unknown; errno?: unknown };
  return code === PG_UNIQUE_VIOLATION || errno === PG_UNIQUE_VIOLATION;
}

export interface MessageRow {
  message_id: string;
  room_id: string;
  sender_id: string | null;
  content: string;
  reply_to_id?: string | null;
  is_recalled: boolean;
  sent_at: Date;
  message_seq?: string | number | null;
  change_seq?: string | number | null;
  revision?: number | null;
}

export interface MessageWithSenderRow {
  message_id: string;
  room_id: string;
  sender_id: string | null;
  content: string;
  reply_to_id?: string | null;
  is_recalled: boolean;
  sent_at: Date;
  message_seq?: string | number | null;
  change_seq?: string | number | null;
  revision?: number | null;
  client_command_id?: string | null;
  sender_user_id?: string | null;
  sender_name?: string | null;
  sender_avatar_url?: string | null;
  sender_deleted_at?: Date | null;
}

export interface MentionRow {
  message_id: string;
  user_id: string;
}

export interface AttachmentRow {
  attachment_id: string;
  message_id?: string | null;
  uploaded_by: string | null;
  file_type: string;
  original_name: string;
  uploaded_at: Date;
}

function mapRowToAttachment(row: AttachmentRow): Attachment {
  return {
    attachmentId: row.attachment_id,
    messageId: row.message_id ?? undefined,
    uploadedBy: row.uploaded_by ?? '',
    fileUrl: `/api/v1/attachments/${row.attachment_id}`,
    fileType: row.file_type,
    originalName: row.original_name,
    uploadedAt: row.uploaded_at,
  };
}

/** BIGINT columns arrive as strings on some drivers; sequences stay well inside Number range. */
function toSeq(value: string | number | null | undefined): number | undefined {
  return value === null || value === undefined ? undefined : Number(value);
}

function mapRowToMessage(row: MessageRow | MessageWithSenderRow): Message {
  return {
    messageId: row.message_id,
    roomId: row.room_id,
    senderId: row.sender_id,
    content: row.content,
    replyToId: row.reply_to_id ?? undefined,
    isRecalled: row.is_recalled,
    sentAt: row.sent_at,
    messageSeq: toSeq(row.message_seq),
    changeSeq: toSeq(row.change_seq),
    revision: row.revision ?? undefined,
  };
}

function mapRowToMessageWithSender(row: MessageWithSenderRow & { mentions?: string[], attachments?: Attachment[] }): MessageWithSender {
  const isDeleted = row.sender_deleted_at !== null && row.sender_deleted_at !== undefined;

  const msg: MessageWithSender = {
    ...mapRowToMessage(row),
    sender: row.sender_user_id
      ? isDeleted 
        ? { userId: row.sender_user_id, name: 'Deleted User', avatarUrl: undefined }
        : {
            userId: row.sender_user_id,
            name: row.sender_name!,
            avatarUrl: row.sender_avatar_url ?? undefined,
          }
      : null,
  };
  if (!row.is_recalled && row.attachments && row.attachments.length > 0) {
    msg.attachments = row.attachments;
  }
  if (row.mentions) {
    msg.mentions = row.mentions;
  }
  return msg;
}

export class MessageRepository implements IMessageRepository {
  constructor(private sql: SQL = defaultSql) {}

  private async fetchMessageWithSenderByIds(messageIds: string[]): Promise<MessageWithSender[]> {
    if (messageIds.length === 0) {
      return [];
    }

    const pgMessageIds = `{${messageIds.join(',')}}`;

    const [messageRows, mentionRows, attachmentRows] = await Promise.all([
      this.sql<MessageWithSenderRow[]>`
        SELECT *
        FROM message_with_sender_view
        WHERE message_id = ANY(${pgMessageIds}::uuid[])
      `,
      this.sql<MentionRow[]>`
        SELECT message_id, user_id
        FROM message_mentions
        WHERE message_id = ANY(${pgMessageIds}::uuid[])
      `,
      this.sql<AttachmentRow[]>`
        SELECT attachment_id, message_id, uploaded_by, file_type, original_name, uploaded_at
        FROM attachments
        WHERE message_id = ANY(${pgMessageIds}::uuid[])
        ORDER BY uploaded_at ASC
      `,
    ]);

    const mentionsByMessageId = new Map<string, string[]>();
    for (const row of mentionRows) {
      const mentions = mentionsByMessageId.get(row.message_id) ?? [];
      mentions.push(row.user_id);
      mentionsByMessageId.set(row.message_id, mentions);
    }

    const attachmentsByMessageId = new Map<string, Attachment[]>();
    for (const row of attachmentRows) {
      if (!row.message_id) continue;
      const attachments = attachmentsByMessageId.get(row.message_id) ?? [];
      attachments.push(mapRowToAttachment(row));
      attachmentsByMessageId.set(row.message_id, attachments);
    }

    const messagesById = new Map(
      messageRows.map((row) => {
        const message = mapRowToMessageWithSender({
          ...row,
          mentions: mentionsByMessageId.get(row.message_id) ?? [],
          attachments: attachmentsByMessageId.get(row.message_id) ?? [],
        });
        return [row.message_id, message] as const;
      }),
    );

    return messageIds
      .map((messageId) => messagesById.get(messageId))
      .filter((message): message is MessageWithSender => Boolean(message));
  }

  async findById(messageId: string): Promise<Message | null> {
    const rows = await this.sql<MessageRow[]>`
      SELECT * FROM messages WHERE message_id = ${messageId}
    `;
    return rows.length === 0 ? null : mapRowToMessage(rows[0]);
  }

  /**
   * Paginates on message_seq. Creation order is fixed at insert and never moves,
   * so an edited message keeps its place in the thread. `afterSeq` is the caller's
   * Join Boundary: messages at or below it predate the membership.
   */
  async findByRoom(roomId: string, opts: { beforeId?: string; limit: number; afterSeq?: number }): Promise<MessageWithSender[]> {
    const limit = Math.max(1, opts.limit);
    const afterSeq = opts.afterSeq ?? null;

    if (opts.beforeId) {
      const cursorRows = await this.sql<{ message_seq: string | number }[]>`
        SELECT message_seq FROM messages WHERE message_id = ${opts.beforeId} AND room_id = ${roomId}
      `;
      if (cursorRows.length === 0) {
        throw new ValidationError('Cursor message not found in this room');
      }
      const cursorSeq = Number(cursorRows[0].message_seq);

      const rows = await this.sql<{ message_id: string }[]>`
        SELECT message_id
        FROM messages
        WHERE room_id = ${roomId}
          AND (${afterSeq}::bigint IS NULL OR message_seq > ${afterSeq})
          AND message_seq < ${cursorSeq}
        ORDER BY message_seq DESC
        LIMIT ${limit}
      `;
      return this.fetchMessageWithSenderByIds(rows.map((row) => row.message_id));
    }

    const rows = await this.sql<{ message_id: string }[]>`
      SELECT message_id
      FROM messages
      WHERE room_id = ${roomId}
        AND (${afterSeq}::bigint IS NULL OR message_seq > ${afterSeq})
      ORDER BY message_seq DESC
      LIMIT ${limit}
    `;
    return this.fetchMessageWithSenderByIds(rows.map((row) => row.message_id));
  }

  /** Returns the message a previous attempt at the same command already created, if any. */
  async findBySenderCommandId(senderId: string, clientCommandId: string): Promise<MessageWithSender | null> {
    const rows = await this.sql<{ message_id: string }[]>`
      SELECT message_id
      FROM messages
      WHERE sender_id = ${senderId} AND client_command_id = ${clientCommandId}
    `;
    if (rows.length === 0) return null;
    const [message] = await this.fetchMessageWithSenderByIds([rows[0].message_id]);
    return message ?? null;
  }

  async create(data: Pick<Message, 'roomId' | 'senderId' | 'content' | 'replyToId'> & { mentions?: string[], attachmentIds?: string[], clientCommandId?: string }): Promise<MessageWithSender> {
    let createdMessageId: string = '';

    // Resolve a replay before opening the transaction, so a repeat of a command
    // that already succeeded never draws a sequence number it would not use.
    if (data.clientCommandId && data.senderId) {
      const replayed = await this.findBySenderCommandId(data.senderId, data.clientCommandId);
      if (replayed) return replayed;
    }

    try {
      await this.sql.begin(async (tx) => {
        const rows = await tx<{ message_id: string }[]>`
          INSERT INTO messages (room_id, sender_id, content, reply_to_id, client_command_id)
          VALUES (${data.roomId}, ${data.senderId}, ${data.content}, ${data.replyToId ?? null}, ${data.clientCommandId ?? null})
          RETURNING message_id
        `;
        createdMessageId = rows[0].message_id;

        if (data.mentions && data.mentions.length > 0) {
          // One statement: every mention insert would otherwise sit inside the
          // globally serialised allocation window opened by this transaction.
          const pgMentionIds = `{${data.mentions.join(',')}}`;
          await tx`
            INSERT INTO message_mentions (message_id, user_id)
            SELECT ${createdMessageId}, user_id
            FROM UNNEST(${pgMentionIds}::uuid[]) AS user_id
          `;
        }

        if (data.attachmentIds && data.attachmentIds.length > 0) {
          const pgAttIds = `{${data.attachmentIds.join(',')}}`;
          const updatedAtts = await tx<{ attachment_id: string }[]>`
            UPDATE attachments SET message_id = ${createdMessageId}
            WHERE attachment_id = ANY(${pgAttIds}::uuid[]) AND message_id IS NULL
            RETURNING attachment_id
          `;
          if (updatedAtts.length !== new Set(data.attachmentIds).size) {
            throw new ValidationError('Attachments must exist and must not already belong to a message');
          }
        }
      });
    } catch (err) {
      // Two concurrent attempts at the same command: the unique index rejects the
      // loser, which then reports the winner's message rather than an error.
      if (data.clientCommandId && data.senderId && isUniqueViolation(err)) {
        const winner = await this.findBySenderCommandId(data.senderId, data.clientCommandId);
        if (winner) return winner;
      }
      throw err;
    }

    const [message] = await this.fetchMessageWithSenderByIds([createdMessageId]);
    return message;
  }

  async markRecalled(messageId: string): Promise<MessageWithSender> {
    // Guarded so a repeated recall is a no-op rather than a fresh revision
    // pushed to every synced client.
    const rows = await this.sql<{ message_id: string }[]>`
      UPDATE messages
      SET is_recalled = true
      WHERE message_id = ${messageId} AND is_recalled = false
      RETURNING message_id
    `;
    if (rows.length === 0) {
      const [existing] = await this.fetchMessageWithSenderByIds([messageId]);
      if (!existing) throw new Error('Message not found');
      return existing;
    }
    const [message] = await this.fetchMessageWithSenderByIds([messageId]);
    return message;
  }

  async update(messageId: string, content: string, mentions?: string[]): Promise<MessageWithSender> {
    await this.sql.begin(async (tx) => {
      const rows = await tx<{ message_id: string }[]>`
        UPDATE messages
        SET content = ${content}
        WHERE message_id = ${messageId}
        RETURNING message_id
      `;
      if (rows.length === 0) {
        throw new Error('Message not found');
      }

      await tx`DELETE FROM message_mentions WHERE message_id = ${messageId}`;

      if (mentions && mentions.length > 0) {
        const pgMentionIds = `{${mentions.join(',')}}`;
        await tx`
          INSERT INTO message_mentions (message_id, user_id)
          SELECT ${messageId}, user_id
          FROM UNNEST(${pgMentionIds}::uuid[]) AS user_id
        `;
      }
    });

    const [message] = await this.fetchMessageWithSenderByIds([messageId]);
    return message;
  }
}
