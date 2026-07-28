import { SQL } from "bun";
import defaultSql from "./db";
import type { Attachment, Message, MessageWithSender } from '@shared/types';
import type { IMessageRepository } from './IMessageRepository';
import { ValidationError } from '../utils/AppError';

export interface MessageRow {
  message_id: string;
  room_id: string;
  sender_id: string | null;
  content: string;
  reply_to_id?: string | null;
  is_recalled: boolean;
  sent_at: Date;
}

export interface MessageWithSenderRow {
  message_id: string;
  room_id: string;
  sender_id: string | null;
  content: string;
  reply_to_id?: string | null;
  is_recalled: boolean;
  sent_at: Date;
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

function mapRowToMessage(row: MessageRow | MessageWithSenderRow): Message {
  return {
    messageId: row.message_id,
    roomId: row.room_id,
    senderId: row.sender_id,
    content: row.content,
    replyToId: row.reply_to_id ?? undefined,
    isRecalled: row.is_recalled,
    sentAt: row.sent_at,
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

  async findByRoom(roomId: string, opts: { beforeId?: string; limit: number; after?: Date }): Promise<MessageWithSender[]> {
    const limit = Math.max(1, opts.limit);

    if (opts.beforeId) {
      const cursorRows = await this.sql<MessageRow[]>`
        SELECT sent_at, message_id, room_id, sender_id, content, is_recalled FROM messages WHERE message_id = ${opts.beforeId} AND room_id = ${roomId}
      `;
      if (cursorRows.length === 0) {
        throw new ValidationError('Cursor message not found in this room');
      }
      const cursor = cursorRows[0];

      const rows = await this.sql<{ message_id: string }[]>`
        SELECT message_id
        FROM messages
        WHERE room_id = ${roomId}
          AND (${opts.after ?? null}::timestamptz IS NULL OR sent_at >= ${opts.after ?? null})
          AND (sent_at, message_id) < (${cursor.sent_at}, ${cursor.message_id})
        ORDER BY sent_at DESC, message_id DESC
        LIMIT ${limit}
      `;
      return this.fetchMessageWithSenderByIds(rows.map((row) => row.message_id));
    }

    const rows = await this.sql<{ message_id: string }[]>`
      SELECT message_id
      FROM messages
      WHERE room_id = ${roomId}
        AND (${opts.after ?? null}::timestamptz IS NULL OR sent_at >= ${opts.after ?? null})
      ORDER BY sent_at DESC, message_id DESC
      LIMIT ${limit}
    `;
    return this.fetchMessageWithSenderByIds(rows.map((row) => row.message_id));
  }

  async create(data: Pick<Message, 'roomId' | 'senderId' | 'content' | 'replyToId'> & { mentions?: string[], attachmentIds?: string[] }): Promise<MessageWithSender> {
    let createdMessageId: string = '';

    await this.sql.begin(async (tx) => {
      const rows = await tx<{ message_id: string }[]>`
        INSERT INTO messages (room_id, sender_id, content, reply_to_id)
        VALUES (${data.roomId}, ${data.senderId}, ${data.content}, ${data.replyToId ?? null})
        RETURNING message_id
      `;
      createdMessageId = rows[0].message_id;

      if (data.mentions && data.mentions.length > 0) {
        for (const userId of data.mentions) {
          await tx`
            INSERT INTO message_mentions (message_id, user_id)
            VALUES (${createdMessageId}, ${userId})
          `;
        }
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

    const [message] = await this.fetchMessageWithSenderByIds([createdMessageId]);
    return message;
  }

  async markRecalled(messageId: string): Promise<MessageWithSender> {
    const rows = await this.sql<{ message_id: string }[]>`
      UPDATE messages
      SET is_recalled = true
      WHERE message_id = ${messageId}
      RETURNING message_id
    `;
    if (rows.length === 0) throw new Error('Message not found');
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
        for (const userId of mentions) {
          await tx`
            INSERT INTO message_mentions (message_id, user_id)
            VALUES (${messageId}, ${userId})
          `;
        }
      }
    });

    const [message] = await this.fetchMessageWithSenderByIds([messageId]);
    return message;
  }
}
