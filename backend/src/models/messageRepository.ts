import { SQL } from "bun";
import defaultSql from "./db";
import type { Attachment, Message, MessageChange, MessageWithSender } from '@shared/types';
import type { IMessageRepository } from './IMessageRepository';
import { ConflictError, ValidationError } from '../utils/AppError';

export interface MessageRow {
  message_id: string;
  room_id: string;
  sender_id: string | null;
  content: string;
  reply_to_id?: string | null;
  is_recalled: boolean;
  sent_at: Date;
  message_sequence: number | string;
  change_sequence: number | string;
  revision: number;
  command_id?: string | null;
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
  message_sequence: number | string;
  change_sequence: number | string;
  revision: number;
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
    messageSequence: Number(row.message_sequence ?? 0),
    changeSequence: Number(row.change_sequence ?? 0),
    revision: Number(row.revision ?? 1),
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
        SELECT sent_at, message_id, room_id, sender_id, content, is_recalled, message_sequence, change_sequence, revision
        FROM messages WHERE message_id = ${opts.beforeId} AND room_id = ${roomId}
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
          AND (
            message_sequence < ${cursor.message_sequence}
            OR (message_sequence = ${cursor.message_sequence} AND sent_at < ${cursor.sent_at})
            OR (message_sequence = ${cursor.message_sequence} AND sent_at = ${cursor.sent_at} AND message_id < ${cursor.message_id})
          )
        ORDER BY message_sequence DESC, sent_at DESC, message_id DESC
        LIMIT ${limit}
      `;
      return this.fetchMessageWithSenderByIds(rows.map((row) => row.message_id));
    }

    const rows = await this.sql<{ message_id: string }[]>`
      SELECT message_id
      FROM messages
      WHERE room_id = ${roomId}
        AND (${opts.after ?? null}::timestamptz IS NULL OR sent_at >= ${opts.after ?? null})
      ORDER BY message_sequence DESC, sent_at DESC, message_id DESC
      LIMIT ${limit}
    `;
    return this.fetchMessageWithSenderByIds(rows.map((row) => row.message_id));
  }

  async create(data: Pick<Message, 'roomId' | 'senderId' | 'content' | 'replyToId'> & { mentions?: string[], attachmentIds?: string[], commandId?: string }): Promise<MessageWithSender> {
    let createdMessageId: string = '';

    await this.sql.begin(async (tx) => {
      const rows = await tx<{ message_id: string }[]>`
        INSERT INTO messages (
          room_id, sender_id, content, reply_to_id, message_sequence, change_sequence, revision, command_id
        )
        SELECT
          ${data.roomId}, ${data.senderId}, ${data.content}, ${data.replyToId ?? null},
          counters.message_sequence + 1,
          counters.change_sequence + 1,
          1,
          ${data.commandId ?? null}
        FROM (
          SELECT message_sequence, change_sequence
          FROM realtime_counters
          WHERE counter_id = true
          FOR UPDATE
        ) counters
        ON CONFLICT (sender_id, command_id) WHERE command_id IS NOT NULL DO NOTHING
        RETURNING message_id
      `;
      if (rows.length === 0) {
        const existing = await tx<{ message_id: string }[]>`
          SELECT message_id
          FROM messages
          WHERE sender_id = ${data.senderId} AND command_id = ${data.commandId}
        `;
        if (existing.length === 0) throw new ConflictError('The message command could not be applied');
        createdMessageId = existing[0].message_id;
        return;
      }
      createdMessageId = rows[0].message_id;

      await tx`
        UPDATE realtime_counters
        SET message_sequence = message_sequence + 1,
            change_sequence = change_sequence + 1
        WHERE counter_id = true
      `;

      await tx`
        INSERT INTO message_changes (
          change_sequence, message_id, room_id, message_sequence, revision,
          change_type, actor_id, command_id, sender_id, content, is_recalled,
          reply_to_id, sent_at
        )
        SELECT m.change_sequence, m.message_id, m.room_id, m.message_sequence,
          m.revision, 'created', m.sender_id, ${data.commandId ?? null},
          m.sender_id, m.content, m.is_recalled, m.reply_to_id, m.sent_at
        FROM messages m
        WHERE m.message_id = ${createdMessageId}
      `;

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

  async markRecalled(messageId: string, expectedRevision?: number, commandId?: string, actorId?: string): Promise<MessageWithSender> {
    await this.sql.begin(async (tx) => {
      if (commandId && actorId) {
        const prior = await tx<{ message_id: string }[]>`
          SELECT message_id FROM message_changes
          WHERE actor_id = ${actorId} AND command_id = ${commandId}
          ORDER BY change_sequence DESC LIMIT 1
        `;
        if (prior.length > 0) {
          if (prior[0].message_id !== messageId) throw new ConflictError('Idempotency-Key was already used for another message');
          return;
        }
      }

      const current = await tx<MessageRow[]>`
        SELECT * FROM messages WHERE message_id = ${messageId} FOR UPDATE
      `;
      if (current.length === 0) throw new Error('Message not found');
      if (expectedRevision !== undefined && Number(current[0].revision) !== expectedRevision) {
        throw new ConflictError('Message revision is stale');
      }
      if (current[0].is_recalled) return;

      const next = await tx<{ change_sequence: number | string }[]>`
        UPDATE realtime_counters
        SET change_sequence = change_sequence + 1
        WHERE counter_id = true
        RETURNING change_sequence
      `;
      const changeSequence = next[0].change_sequence;
      await tx`
        UPDATE messages
        SET is_recalled = true,
            change_sequence = ${changeSequence},
            revision = revision + 1
        WHERE message_id = ${messageId}
      `;
      await tx`
        INSERT INTO message_changes (
          change_sequence, message_id, room_id, message_sequence, revision,
          change_type, actor_id, command_id, sender_id, content, is_recalled,
          reply_to_id, sent_at
        )
        SELECT ${changeSequence}, message_id, room_id, message_sequence,
          revision, 'recalled', ${actorId ?? null}, ${commandId ?? null},
          sender_id, content, true, reply_to_id, sent_at
        FROM messages WHERE message_id = ${messageId}
      `;
    });
    const [message] = await this.fetchMessageWithSenderByIds([messageId]);
    return message;
  }

  async update(messageId: string, content: string, mentions?: string[], expectedRevision?: number, commandId?: string, actorId?: string): Promise<MessageWithSender> {
    await this.sql.begin(async (tx) => {
      if (commandId && actorId) {
        const prior = await tx<{ message_id: string }[]>`
          SELECT message_id FROM message_changes
          WHERE actor_id = ${actorId} AND command_id = ${commandId}
          ORDER BY change_sequence DESC LIMIT 1
        `;
        if (prior.length > 0) {
          if (prior[0].message_id !== messageId) throw new ConflictError('Idempotency-Key was already used for another message');
          return;
        }
      }

      const rows = await tx<MessageRow[]>`
        SELECT * FROM messages WHERE message_id = ${messageId} FOR UPDATE
      `;
      if (rows.length === 0) {
        throw new Error('Message not found');
      }
      if (expectedRevision !== undefined && Number(rows[0].revision) !== expectedRevision) {
        throw new ConflictError('Message revision is stale');
      }

      const next = await tx<{ change_sequence: number | string }[]>`
        UPDATE realtime_counters
        SET change_sequence = change_sequence + 1
        WHERE counter_id = true
        RETURNING change_sequence
      `;
      const changeSequence = next[0].change_sequence;
      await tx`
        UPDATE messages
        SET content = ${content},
            change_sequence = ${changeSequence},
            revision = revision + 1
        WHERE message_id = ${messageId}
      `;

      await tx`DELETE FROM message_mentions WHERE message_id = ${messageId}`;

      if (mentions && mentions.length > 0) {
        for (const userId of mentions) {
          await tx`
            INSERT INTO message_mentions (message_id, user_id)
            VALUES (${messageId}, ${userId})
          `;
        }
      }

      await tx`
        INSERT INTO message_changes (
          change_sequence, message_id, room_id, message_sequence, revision,
          change_type, actor_id, command_id, sender_id, content, is_recalled,
          reply_to_id, sent_at
        )
        SELECT ${changeSequence}, message_id, room_id, message_sequence,
          revision, 'edited', ${actorId ?? null}, ${commandId ?? null},
          sender_id, content, is_recalled, reply_to_id, sent_at
        FROM messages WHERE message_id = ${messageId}
      `;
    });

    const [message] = await this.fetchMessageWithSenderByIds([messageId]);
    return message;
  }

  async findChangesForUser(userId: string, cursor: number, limit: number): Promise<MessageChange[]> {
    const rows = await this.sql<Array<{
      change_sequence: number | string;
      message_sequence: number | string;
      revision: number;
      change_type: MessageChange['changeType'];
      message_id: string;
      room_id: string;
      sender_id: string | null;
      content: string;
      is_recalled: boolean;
      reply_to_id: string | null;
      sent_at: Date;
      sender_user_id: string | null;
      sender_name: string | null;
      sender_avatar_url: string | null;
      sender_deleted_at: Date | null;
    }>>`
      SELECT
        mc.change_sequence, mc.message_sequence, mc.revision, mc.change_type,
        mc.message_id, mc.room_id, mc.sender_id, mc.content, mc.is_recalled,
        mc.reply_to_id, mc.sent_at,
        u.user_id AS sender_user_id, u.name AS sender_name,
        u.avatar_url AS sender_avatar_url, u.deleted_at AS sender_deleted_at
      FROM message_changes mc
      JOIN room_members rm ON rm.room_id = mc.room_id AND rm.user_id = ${userId}
      JOIN chat_rooms cr ON cr.room_id = mc.room_id
      LEFT JOIN users u ON u.user_id = mc.sender_id
      WHERE mc.change_sequence > ${cursor}
        AND rm.role <> 'pending'
        AND (cr.view_history OR mc.message_sequence > rm.join_boundary)
      ORDER BY mc.change_sequence ASC
      LIMIT ${Math.max(1, Math.min(limit, 500))}
    `;

    const messageIds = rows.map((row) => row.message_id);
    const pgMessageIds = `{${messageIds.join(',')}}`;
    const [mentionRows, attachmentRows] = messageIds.length === 0
      ? [[], []] as const
      : await Promise.all([
          this.sql<MentionRow[]>`
            SELECT message_id, user_id FROM message_mentions
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

    return rows.map((row) => {
      const isDeleted = row.sender_deleted_at !== null;
      const message: MessageWithSender = {
        messageId: row.message_id,
        roomId: row.room_id,
        senderId: row.sender_id,
        content: row.content,
        replyToId: row.reply_to_id ?? undefined,
        isRecalled: row.is_recalled,
        sentAt: row.sent_at,
        messageSequence: Number(row.message_sequence),
        changeSequence: Number(row.change_sequence),
        revision: row.revision,
        sender: row.sender_user_id
          ? isDeleted
            ? { userId: row.sender_user_id, name: 'Deleted User' }
            : { userId: row.sender_user_id, name: row.sender_name!, avatarUrl: row.sender_avatar_url ?? undefined }
          : null,
      };
      if (!row.is_recalled) {
        message.attachments = attachmentsByMessageId.get(row.message_id) ?? [];
      }
      message.mentions = mentionsByMessageId.get(row.message_id) ?? [];
      return {
        changeSequence: Number(row.change_sequence),
        messageSequence: Number(row.message_sequence),
        revision: row.revision,
        changeType: row.change_type,
        message,
      };
    });
  }
}
