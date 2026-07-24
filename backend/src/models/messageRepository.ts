import { Pool } from 'pg';
import type { Attachment, Message, MessageWithSender } from '@shared/types';
import type { IMessageRepository } from './IMessageRepository';
import { ValidationError } from '../utils/AppError';

function mapRowToAttachment(row: any): Attachment {
  return {
    attachmentId: row.attachment_id,
    messageId: row.message_id ?? undefined,
    uploadedBy: row.uploaded_by,
    fileUrl: `/api/v1/attachments/${row.attachment_id}`,
    fileType: row.file_type,
    originalName: row.original_name,
    uploadedAt: row.uploaded_at,
  };
}

function mapRowToMessage(row: any): Message {
  const msg: Message = {
    messageId: row.message_id,
    roomId: row.room_id,
    senderId: row.sender_id,
    content: row.content,
    replyToId: row.reply_to_id ?? undefined,
    isRecalled: row.is_recalled,
    sentAt: row.sent_at,
  };
  if (!row.is_recalled && row.attachments && row.attachments.length > 0) {
    msg.attachments = row.attachments.filter(Boolean);
  }
  return msg;
}

function mapRowToMessageWithSender(row: any): MessageWithSender {
  const isDeleted = row.sender_deleted_at !== null && row.sender_deleted_at !== undefined;

  const msg: MessageWithSender = {
    ...mapRowToMessage(row),
    sender: row.sender_user_id
      ? isDeleted 
        ? { userId: row.sender_user_id, name: 'Deleted User', avatarUrl: undefined }
        : {
            userId: row.sender_user_id,
            name: row.sender_name,
            avatarUrl: row.sender_avatar_url ?? undefined,
          }
      : null,
  };
  if (row.mentions) {
    msg.mentions = row.mentions;
  }
  return msg;
}

interface MessageWithSenderRow {
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

interface MentionRow {
  message_id: string;
  user_id: string;
}

interface AttachmentRow {
  attachment_id: string;
  message_id?: string | null;
  uploaded_by: string | null;
  file_type: string;
  original_name: string;
  uploaded_at: Date;
}

export class MessageRepository implements IMessageRepository {
  constructor(private db: Pool) {}

  private async fetchMessageWithSenderByIds(messageIds: string[]): Promise<MessageWithSender[]> {
    if (messageIds.length === 0) {
      return [];
    }

    const [messageRes, mentionRes, attachmentRes] = await Promise.all([
      this.db.query<MessageWithSenderRow>(
        `SELECT *
         FROM message_with_sender_view
         WHERE message_id = ANY($1::uuid[])`,
        [messageIds],
      ),
      this.db.query<MentionRow>(
        `SELECT message_id, user_id
         FROM message_mentions
         WHERE message_id = ANY($1::uuid[])`,
        [messageIds],
      ),
      this.db.query<AttachmentRow>(
        `SELECT attachment_id, message_id, uploaded_by, file_type, original_name, uploaded_at
         FROM attachments
         WHERE message_id = ANY($1::uuid[])
         ORDER BY uploaded_at ASC`,
        [messageIds],
      ),
    ]);

    const mentionsByMessageId = new Map<string, string[]>();
    for (const row of mentionRes.rows) {
      const mentions = mentionsByMessageId.get(row.message_id) ?? [];
      mentions.push(row.user_id);
      mentionsByMessageId.set(row.message_id, mentions);
    }

    const attachmentsByMessageId = new Map<string, Attachment[]>();
    for (const row of attachmentRes.rows) {
      if (!row.message_id) continue;
      const attachments = attachmentsByMessageId.get(row.message_id) ?? [];
      attachments.push(mapRowToAttachment(row));
      attachmentsByMessageId.set(row.message_id, attachments);
    }

    const messagesById = new Map(
      messageRes.rows.map((row) => {
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
    const res = await this.db.query(
      'SELECT * FROM messages WHERE message_id = $1',
      [messageId],
    );
    return res.rows.length === 0 ? null : mapRowToMessage(res.rows[0]);
  }

  async findByRoom(roomId: string, opts: { beforeId?: string; limit: number; after?: Date }): Promise<MessageWithSender[]> {
    const limit = Math.max(1, opts.limit);

    if (opts.beforeId) {
      const cursorRes = await this.db.query(
        'SELECT sent_at, message_id FROM messages WHERE message_id = $1 AND room_id = $2',
        [opts.beforeId, roomId]
      );
      if (cursorRes.rows.length === 0) {
        throw new ValidationError('Cursor message not found in this room');
      }
      const cursor = cursorRes.rows[0];

      const res = await this.db.query<{ message_id: string }>(
        `SELECT message_id
         FROM messages
         WHERE room_id = $1
           AND ($5::timestamptz IS NULL OR sent_at >= $5)
           AND (sent_at, message_id) < ($2, $3)
         ORDER BY sent_at DESC, message_id DESC
         LIMIT $4`,
        [roomId, cursor.sent_at, cursor.message_id, limit, opts.after ?? null],
      );
      return this.fetchMessageWithSenderByIds(res.rows.map((row) => row.message_id));
    }

    const res = await this.db.query<{ message_id: string }>(
      `SELECT message_id
       FROM messages
       WHERE room_id = $1
         AND ($3::timestamptz IS NULL OR sent_at >= $3)
       ORDER BY sent_at DESC, message_id DESC
       LIMIT $2`,
      [roomId, limit, opts.after ?? null],
    );
    return this.fetchMessageWithSenderByIds(res.rows.map((row) => row.message_id));
  }

  async create(data: Pick<Message, 'roomId' | 'senderId' | 'content' | 'replyToId'> & { mentions?: string[], attachmentIds?: string[] }): Promise<MessageWithSender> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const res = await client.query(
        `INSERT INTO messages (room_id, sender_id, content, reply_to_id)
         VALUES ($1, $2, $3, $4)
         RETURNING message_id`,
        [data.roomId, data.senderId, data.content, data.replyToId ?? null],
      );
      const messageId = res.rows[0].message_id as string;
      
      if (data.mentions && data.mentions.length > 0) {
        const values = data.mentions.map((_, i) => `($1, $${i + 2})`).join(', ');
        const params = [messageId, ...data.mentions];
        await client.query(`INSERT INTO message_mentions (message_id, user_id) VALUES ${values}`, params);
      }
      
      if (data.attachmentIds && data.attachmentIds.length > 0) {
        const attachmentRes = await client.query(
          'UPDATE attachments SET message_id = $1 WHERE attachment_id = ANY($2::uuid[]) AND message_id IS NULL RETURNING *',
          [messageId, data.attachmentIds],
        );
        if (attachmentRes.rowCount !== new Set(data.attachmentIds).size) {
          throw new ValidationError('Attachments must exist and must not already belong to a message');
        }
      }
      
      await client.query('COMMIT');
      const [message] = await this.fetchMessageWithSenderByIds([messageId]);
      return message;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async markRecalled(messageId: string): Promise<MessageWithSender> {
    const res = await this.db.query(
      `UPDATE messages
       SET is_recalled = true
       WHERE message_id = $1
       RETURNING message_id`,
      [messageId],
    );
    if (res.rows.length === 0) throw new Error('Message not found');
    const [message] = await this.fetchMessageWithSenderByIds([messageId]);
    return message;
  }

  async update(messageId: string, content: string, mentions?: string[]): Promise<MessageWithSender> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const res = await client.query(
        `UPDATE messages
         SET content = $1
         WHERE message_id = $2
         RETURNING message_id`,
        [content, messageId],
      );
      if (res.rows.length === 0) {
        throw new Error('Message not found');
      }

      await client.query(
        'DELETE FROM message_mentions WHERE message_id = $1',
        [messageId],
      );

      if (mentions && mentions.length > 0) {
        const values = mentions.map((_, i) => `($1, $${i + 2})`).join(', ');
        const params = [messageId, ...mentions];
        await client.query(
          `INSERT INTO message_mentions (message_id, user_id) VALUES ${values}`,
          params,
        );
      }

      await client.query('COMMIT');
      const [message] = await this.fetchMessageWithSenderByIds([messageId]);
      return message;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
}
