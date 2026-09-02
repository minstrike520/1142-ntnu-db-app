import { SQL } from 'bun';
import defaultSql from '../db';
import type { Message, MessageWithSender } from '@shared/types';
import { ValidationError } from '../../utils/AppError';
import {
  mapMessageRow,
  mapMessageWithSenderRow,
  type MessageRow,
  type MessageWithSenderRow,
} from './mappers';

export class MessageQueries {
  constructor(private readonly sql: SQL = defaultSql) {}

  async fetchMessageWithSenderByIds(messageIds: string[]): Promise<MessageWithSender[]> {
    if (messageIds.length === 0) return [];

    const pgMessageIds = `{${messageIds.join(',')}}`;
    const messageRows = await this.sql<Array<MessageWithSenderRow & {
      mentions: unknown;
      attachment_snapshot: unknown;
    }>>`
      SELECT v.*,
             COALESCE((
               SELECT jsonb_agg(mm.user_id ORDER BY mm.user_id)
               FROM message_mentions mm
               WHERE mm.message_id = v.message_id
             ), '[]'::jsonb) AS mentions,
             COALESCE((
               SELECT jsonb_agg(jsonb_build_object(
                 'attachment_id', a.attachment_id,
                 'message_id', a.message_id,
                 'uploaded_by', a.uploaded_by,
                 'file_type', a.file_type,
                 'original_name', a.original_name,
                 'uploaded_at', a.uploaded_at
               ) ORDER BY a.uploaded_at, a.attachment_id)
               FROM attachments a
               WHERE a.message_id = v.message_id
             ), '[]'::jsonb) AS attachment_snapshot
      FROM message_with_sender_view v
      WHERE v.message_id = ANY(${pgMessageIds}::uuid[])
    `;

    const messagesById = new Map(
      messageRows.map((row) => [
        row.message_id,
        mapMessageWithSenderRow({
          ...row,
          attachments: row.attachment_snapshot,
        }),
      ] as const),
    );

    return messageIds
      .map((messageId) => messagesById.get(messageId))
      .filter((message): message is MessageWithSender => Boolean(message));
  }

  async findById(messageId: string): Promise<Message | null> {
    const rows = await this.sql<MessageRow[]>`
      SELECT * FROM messages WHERE message_id = ${messageId}
    `;
    return rows.length === 0 ? null : mapMessageRow(rows[0]);
  }

  async findByRoom(
    roomId: string,
    opts: { beforeId?: string; limit: number; after?: Date; afterSequence?: number },
  ): Promise<MessageWithSender[]> {
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
          AND (
            ${opts.afterSequence ?? null}::bigint IS NULL
            OR message_sequence > ${opts.afterSequence ?? null}
            OR (message_sequence = 0 AND sent_at >= ${opts.after ?? null})
          )
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
        AND (
          ${opts.afterSequence ?? null}::bigint IS NULL
          OR message_sequence > ${opts.afterSequence ?? null}
          OR (message_sequence = 0 AND sent_at >= ${opts.after ?? null})
        )
      ORDER BY message_sequence DESC, sent_at DESC, message_id DESC
      LIMIT ${limit}
    `;
    return this.fetchMessageWithSenderByIds(rows.map((row) => row.message_id));
  }
}
