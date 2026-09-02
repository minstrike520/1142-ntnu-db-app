import { SQL } from 'bun';
import defaultSql from '../db';
import type { MessageChange, MessageWithSender } from '@shared/types';
import { applyMessageSnapshot, mapMessageChangeRow, type MessageSnapshotRow } from './mappers';
import type { MessageQueries } from './messageQueries';

export class MessageChangeQueries {
  constructor(
    private readonly sql: SQL = defaultSql,
    private readonly messageQueries?: MessageQueries,
  ) {}

  async fetchChangeSnapshot(changeSequence: number, messageId: string): Promise<MessageWithSender> {
    const [message] = this.messageQueries
      ? await this.messageQueries.fetchMessageWithSenderByIds([messageId])
      : [];
    const rows = await this.sql<MessageSnapshotRow[]>`
      SELECT content, reply_to_id, is_recalled, sent_at,
             message_sequence, change_sequence, revision, mentions, attachments
      FROM message_changes
      WHERE change_sequence = ${changeSequence} AND message_id = ${messageId}
    `;
    if (!message || rows.length === 0) throw new Error('Message change snapshot not found');
    return applyMessageSnapshot(message, {
      ...rows[0],
      current_is_recalled: message.isRecalled,
    });
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
      current_is_recalled: boolean;
      mentions: unknown;
      attachments: unknown;
    }>>`
      SELECT
        mc.change_sequence, mc.message_sequence, mc.revision, mc.change_type,
        mc.message_id, mc.room_id, mc.sender_id, mc.content, mc.is_recalled,
        mc.reply_to_id, mc.sent_at,
        mc.mentions, mc.attachments,
        current_message.is_recalled AS current_is_recalled,
        u.user_id AS sender_user_id, u.name AS sender_name,
        u.avatar_url AS sender_avatar_url, u.deleted_at AS sender_deleted_at
      FROM message_changes mc
      JOIN room_members rm ON rm.room_id = mc.room_id AND rm.user_id = ${userId}
      JOIN chat_rooms cr ON cr.room_id = mc.room_id
      JOIN messages current_message ON current_message.message_id = mc.message_id
      LEFT JOIN users u ON u.user_id = mc.sender_id
      WHERE mc.change_sequence > ${cursor}
        AND rm.role <> 'pending'
        AND NOT (
          cr.type = 'private'
          AND EXISTS (
            SELECT 1
            FROM room_members other
            JOIN blocks b ON (
              (b.blocker_id = ${userId} AND b.blocked_id = other.user_id)
              OR (b.blocker_id = other.user_id AND b.blocked_id = ${userId})
            )
            WHERE other.room_id = rm.room_id
              AND other.user_id <> ${userId}
              AND other.role <> 'pending'
          )
        )
        AND (
          cr.view_history
          OR mc.message_sequence > rm.join_boundary
          OR (mc.message_sequence = 0 AND mc.sent_at >= rm.join_time)
        )
      ORDER BY mc.change_sequence ASC
      LIMIT ${Math.max(1, Math.min(limit, 500))}
    `;

    return rows.map(mapMessageChangeRow);
  }
}
