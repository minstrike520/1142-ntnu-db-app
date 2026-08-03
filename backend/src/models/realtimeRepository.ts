import { SQL } from 'bun';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { RealtimeMessage } from '@shared/realtime';
import type { RoomMemberRole } from '@shared/types';
import { AppError } from '../utils/AppError';
import defaultSql from './db';

export type RealtimeRepositoryErrorCode =
  | 'IDEMPOTENCY_CONFLICT'
  | 'VERSION_CONFLICT'
  | 'CURSOR_INVALID'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'INVALID_OPERATION';

export class RealtimeRepositoryError extends AppError {
  readonly realtimeCode: RealtimeRepositoryErrorCode;

  constructor(code: RealtimeRepositoryErrorCode, message: string = code) {
    const statusCode = code === 'FORBIDDEN'
      ? 403
      : code === 'NOT_FOUND'
        ? 404
        : code === 'VERSION_CONFLICT' || code === 'IDEMPOTENCY_CONFLICT'
          ? 409
          : 400;
    super(statusCode, message, code);
    this.name = 'RealtimeRepositoryError';
    this.realtimeCode = code;
  }
}

interface RealtimeRepositoryOptions {
  cursorSecret?: string;
}

interface MessageRow {
  message_id: string;
  room_id: string;
  sender_id: string | null;
  content: string;
  reply_to_id: string | null;
  is_recalled: boolean;
  sent_at: Date | string;
  revision: bigint | string | number;
  sender_name: string | null;
  sender_avatar_url: string | null;
}

interface DeltaCursor {
  version: 1;
  userId: string;
  scopeHash: string;
  position: string;
  highWater: string;
  complete: boolean;
}

interface MembershipScopeRow {
  room_id: string;
  membership_epoch: string;
  join_time: Date | string;
  view_history: boolean;
}

interface AttachmentExtraRow {
  message_id: string;
  attachment_id: string;
  uploaded_by: string | null;
  file_type: string;
  original_name: string;
  uploaded_at: Date | string;
}

export interface MessageMutationResult {
  message: RealtimeMessage;
  replayed: boolean;
  readAdvanced?: boolean;
}

export interface MessageDeltaResult {
  changes: Array<{
    type: 'message.created' | 'message.updated' | 'message.recalled';
    revision: string;
    message: RealtimeMessage;
  }>;
  cursor: string;
  highWaterRevision: string;
  complete: boolean;
}

const asIso = (value: Date | string): string => new Date(value).toISOString();
const asRevision = (value: bigint | string | number): string => String(value);

export class RealtimeRepository {
  private readonly cursorSecret: string;

  constructor(
    private readonly sql: SQL = defaultSql,
    options: RealtimeRepositoryOptions = {},
  ) {
    const configuredSecret = options.cursorSecret ?? (
      process.env.REALTIME_CURSOR_SECRET?.trim() || process.env.JWT_SECRET?.trim()
    );
    if (!configuredSecret && process.env.NODE_ENV === 'production') {
      throw new Error('REALTIME_CURSOR_SECRET is not defined in production environment.');
    }
    this.cursorSecret = configuredSecret || 'default-dev-realtime-cursor-secret';
  }

  async listAuthorizedRoomIds(userId: string): Promise<string[]> {
    const rows = await this.sql<{ room_id: string }[]>`
      SELECT room_id
      FROM room_members
      WHERE user_id = ${userId} AND role <> 'pending'
      ORDER BY room_id
    `;
    return rows.map((row) => row.room_id);
  }

  async hasAuthorizedMembership(userId: string, roomId: string): Promise<boolean> {
    const rows = await this.sql<{ allowed: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM room_members
        WHERE user_id = ${userId} AND room_id = ${roomId} AND role <> 'pending'
      ) AS allowed
    `;
    return Boolean(rows[0]?.allowed);
  }

  async getRoomAccess(userId: string, roomId: string): Promise<{
    role: RoomMemberRole;
    isMuted: boolean;
    isArchived: boolean;
    isReadonly: boolean;
  } | null> {
    const rows = await this.sql<{
      role: RoomMemberRole;
      is_muted: boolean;
      is_archived: boolean;
      is_readonly: boolean;
    }[]>`
      SELECT rm.role, rm.is_muted, room.is_archived, room.is_readonly
      FROM room_members rm
      JOIN chat_rooms room ON room.room_id = rm.room_id
      WHERE rm.user_id = ${userId} AND rm.room_id = ${roomId} AND rm.role <> 'pending'
    `;
    return rows[0] ? {
      role: rows[0].role,
      isMuted: rows[0].is_muted,
      isArchived: rows[0].is_archived,
      isReadonly: rows[0].is_readonly,
    } : null;
  }

  async resolveMentionUserIds(
    roomId: string,
    names: string[],
    includeEveryone: boolean,
    excludeUserId: string,
  ): Promise<string[]> {
    const resolved = new Set<string>();
    if (names.length > 0) {
      const pgNames = this.sql.array(names, 'text');
      const direct = await this.sql<{ user_id: string }[]>`
        SELECT u.user_id
        FROM room_members rm
        JOIN users u ON u.user_id = rm.user_id
        WHERE rm.room_id = ${roomId} AND rm.role <> 'pending'
          AND (u.name = ANY(${pgNames}) OR rm.nickname = ANY(${pgNames}))
      `;
      direct.forEach((row) => resolved.add(row.user_id));
    }
    if (includeEveryone) {
      const members = await this.sql<{ user_id: string }[]>`
        SELECT user_id FROM room_members
        WHERE room_id = ${roomId} AND role <> 'pending' AND user_id <> ${excludeUserId}
      `;
      members.forEach((row) => resolved.add(row.user_id));
    }
    return [...resolved];
  }

  async createMessage(input: {
    userId: string;
    commandId: string;
    payloadHash: string;
    roomId: string;
    content: string;
    replyToId?: string;
    mentionIds?: string[];
    attachmentIds?: string[];
  }): Promise<MessageMutationResult> {
    let messageId = '';
    let replayed = false;
    let replayRevision: string | undefined;
    let readAdvanced = false;

    await this.sql.begin(async (tx) => {
      const claim = await tx<{ command_id: string }[]>`
        INSERT INTO message_commands (user_id, command_id, command_type, payload_hash)
        VALUES (${input.userId}, ${input.commandId}, 'message.send', ${input.payloadHash})
        ON CONFLICT (user_id, command_id) DO NOTHING
        RETURNING command_id
      `;

      if (claim.length === 0) {
        const existing = await tx<{
          command_type: string;
          payload_hash: string;
          message_id: string | null;
          result_revision: bigint | string | number | null;
        }[]>`
          SELECT command_type, payload_hash, message_id, result_revision
          FROM message_commands
          WHERE user_id = ${input.userId} AND command_id = ${input.commandId}
        `;
        if (existing[0]?.command_type !== 'message.send' || existing[0]?.payload_hash !== input.payloadHash) {
          throw new RealtimeRepositoryError('IDEMPOTENCY_CONFLICT');
        }
        if (!existing[0]?.message_id || existing[0].result_revision === null) {
          throw new RealtimeRepositoryError('INVALID_OPERATION');
        }
        messageId = existing[0].message_id;
        replayRevision = asRevision(existing[0].result_revision);
        replayed = true;
        return;
      }

      const created = await tx<{
        message_id: string;
        revision: bigint | string | number;
        sent_at: Date | string;
      }[]>`
        INSERT INTO messages (room_id, sender_id, content, reply_to_id)
        VALUES (${input.roomId}, ${input.userId}, ${input.content}, ${input.replyToId ?? null})
        RETURNING message_id, revision, sent_at
      `;
      messageId = created[0].message_id;

      if (input.mentionIds?.length) {
        for (const mentionedUserId of new Set(input.mentionIds)) {
          await tx`
            INSERT INTO message_mentions (message_id, user_id)
            VALUES (${messageId}, ${mentionedUserId})
            ON CONFLICT DO NOTHING
          `;
        }
      }

      if (input.attachmentIds?.length) {
        const uniqueAttachmentIds = [...new Set(input.attachmentIds)];
        const attached = await tx<{ attachment_id: string }[]>`
          UPDATE attachments
          SET message_id = ${messageId}
          WHERE attachment_id = ANY(${tx.array(uniqueAttachmentIds, 'uuid')}) AND message_id IS NULL
          RETURNING attachment_id
        `;
        if (attached.length !== uniqueAttachmentIds.length) {
          throw new RealtimeRepositoryError('INVALID_OPERATION', 'Attachments are unavailable');
        }
      }

      await tx`
        INSERT INTO message_changes (
          revision, message_id, room_id, change_type, sender_id, content, reply_to_id, is_recalled, sent_at
        )
        SELECT revision, message_id, room_id, 'created', sender_id, content, reply_to_id, is_recalled, sent_at
        FROM messages WHERE message_id = ${messageId}
      `;
      await tx`
        UPDATE message_commands SET message_id = ${messageId}, result_revision = ${created[0].revision}
        WHERE user_id = ${input.userId} AND command_id = ${input.commandId}
      `;
      const readUpdates = await tx<{ message_id: string }[]>`
        UPDATE room_members
        SET last_read_id = ${messageId}
        WHERE room_id = ${input.roomId} AND user_id = ${input.userId}
          AND (
            last_read_id IS NULL
            OR (SELECT sent_at FROM messages WHERE message_id = last_read_id) < ${created[0].sent_at}
            OR (
              (SELECT sent_at FROM messages WHERE message_id = last_read_id) = ${created[0].sent_at}
              AND last_read_id < ${messageId}
            )
          )
        RETURNING last_read_id AS message_id
      `;
      readAdvanced = readUpdates.length > 0;
    });

    return {
      message: replayRevision
        ? await this.loadMessageAtRevision(replayRevision)
        : await this.loadMessage(messageId),
      replayed,
      readAdvanced,
    };
  }

  async editMessage(input: {
    userId: string;
    roomId: string;
    commandId: string;
    payloadHash: string;
    messageId: string;
    expectedRevision: string;
    content: string;
    mentionIds?: string[];
  }): Promise<MessageMutationResult> {
    let replayRevision: string | undefined;
    await this.sql.begin(async (tx) => {
      const claim = await tx<{ command_id: string }[]>`
        INSERT INTO message_commands (user_id, command_id, command_type, payload_hash)
        VALUES (${input.userId}, ${input.commandId}, 'message.edit', ${input.payloadHash})
        ON CONFLICT (user_id, command_id) DO NOTHING
        RETURNING command_id
      `;
      if (claim.length === 0) {
        const existingCommand = await tx<{
          command_type: string;
          payload_hash: string;
          result_revision: bigint | string | number | null;
        }[]>`
          SELECT command_type, payload_hash, result_revision FROM message_commands
          WHERE user_id = ${input.userId} AND command_id = ${input.commandId}
        `;
        if (
          existingCommand[0]?.command_type !== 'message.edit'
          || existingCommand[0]?.payload_hash !== input.payloadHash
        ) throw new RealtimeRepositoryError('IDEMPOTENCY_CONFLICT');
        if (existingCommand[0].result_revision === null) {
          throw new RealtimeRepositoryError('INVALID_OPERATION');
        }
        replayRevision = asRevision(existingCommand[0].result_revision);
        return;
      }
      const existing = await tx<{ sender_id: string | null; revision: bigint | string | number; is_recalled: boolean }[]>`
        SELECT sender_id, revision, is_recalled
        FROM messages WHERE message_id = ${input.messageId} AND room_id = ${input.roomId}
        FOR UPDATE
      `;
      if (!existing[0]) throw new RealtimeRepositoryError('NOT_FOUND');
      if (existing[0].sender_id !== input.userId) throw new RealtimeRepositoryError('FORBIDDEN');
      if (existing[0].is_recalled) throw new RealtimeRepositoryError('INVALID_OPERATION');
      if (asRevision(existing[0].revision) !== input.expectedRevision) {
        throw new RealtimeRepositoryError('VERSION_CONFLICT');
      }

      const revisionRows = await tx<{ revision: bigint | string | number }[]>`
        SELECT nextval('realtime_revision_seq') AS revision
      `;
      const revision = revisionRows[0].revision;
      await tx`
        UPDATE messages
        SET content = ${input.content}, revision = ${revision}
        WHERE message_id = ${input.messageId}
      `;
      await tx`DELETE FROM message_mentions WHERE message_id = ${input.messageId}`;
      for (const mentionedUserId of new Set(input.mentionIds ?? [])) {
        await tx`
          INSERT INTO message_mentions (message_id, user_id)
          VALUES (${input.messageId}, ${mentionedUserId})
        `;
      }
      await tx`
        INSERT INTO message_changes (
          revision, message_id, room_id, change_type, sender_id, content, reply_to_id, is_recalled, sent_at
        )
        SELECT revision, message_id, room_id, 'updated', sender_id, content, reply_to_id, is_recalled, sent_at
        FROM messages WHERE message_id = ${input.messageId}
      `;
      await tx`
        UPDATE message_commands
        SET message_id = ${input.messageId}, result_revision = ${revision}
        WHERE user_id = ${input.userId} AND command_id = ${input.commandId}
      `;
    });
    return {
      message: replayRevision
        ? await this.loadMessageAtRevision(replayRevision)
        : await this.loadMessage(input.messageId),
      replayed: replayRevision !== undefined,
    };
  }

  async recallMessage(input: {
    userId: string;
    roomId: string;
    commandId: string;
    payloadHash: string;
    messageId: string;
    expectedRevision?: string;
    actorRole: RoomMemberRole;
  }): Promise<MessageMutationResult> {
    let replayed = false;
    let replayRevision: string | undefined;
    await this.sql.begin(async (tx) => {
      const claim = await tx<{ command_id: string }[]>`
        INSERT INTO message_commands (user_id, command_id, command_type, payload_hash)
        VALUES (${input.userId}, ${input.commandId}, 'message.recall', ${input.payloadHash})
        ON CONFLICT (user_id, command_id) DO NOTHING
        RETURNING command_id
      `;
      if (claim.length === 0) {
        const existingCommand = await tx<{
          command_type: string;
          payload_hash: string;
          result_revision: bigint | string | number | null;
        }[]>`
          SELECT command_type, payload_hash, result_revision FROM message_commands
          WHERE user_id = ${input.userId} AND command_id = ${input.commandId}
        `;
        if (
          existingCommand[0]?.command_type !== 'message.recall'
          || existingCommand[0]?.payload_hash !== input.payloadHash
        ) throw new RealtimeRepositoryError('IDEMPOTENCY_CONFLICT');
        if (existingCommand[0].result_revision === null) {
          throw new RealtimeRepositoryError('INVALID_OPERATION');
        }
        replayed = true;
        replayRevision = asRevision(existingCommand[0].result_revision);
        return;
      }
      const existing = await tx<{ sender_id: string | null; revision: bigint | string | number; is_recalled: boolean }[]>`
        SELECT sender_id, revision, is_recalled
        FROM messages WHERE message_id = ${input.messageId} AND room_id = ${input.roomId}
        FOR UPDATE
      `;
      if (!existing[0]) throw new RealtimeRepositoryError('NOT_FOUND');
      if (existing[0].sender_id !== input.userId) {
        if (input.actorRole !== 'owner' && input.actorRole !== 'admin') {
          throw new RealtimeRepositoryError('FORBIDDEN');
        }
        if (input.actorRole === 'admin' && existing[0].sender_id) {
          const sender = await tx<{ role: RoomMemberRole }[]>`
            SELECT role FROM room_members
            WHERE room_id = ${input.roomId} AND user_id = ${existing[0].sender_id}
          `;
          if (sender[0]?.role === 'owner' || sender[0]?.role === 'admin') {
            throw new RealtimeRepositoryError('FORBIDDEN');
          }
        }
      }
      if (existing[0].is_recalled) {
        replayed = true;
        replayRevision = asRevision(existing[0].revision);
        await tx`
          UPDATE message_commands
          SET message_id = ${input.messageId}, result_revision = ${existing[0].revision}
          WHERE user_id = ${input.userId} AND command_id = ${input.commandId}
        `;
        return;
      }
      if (input.expectedRevision && asRevision(existing[0].revision) !== input.expectedRevision) {
        throw new RealtimeRepositoryError('VERSION_CONFLICT');
      }

      const revisionRows = await tx<{ revision: bigint | string | number }[]>`
        SELECT nextval('realtime_revision_seq') AS revision
      `;
      const revision = revisionRows[0].revision;
      await tx`
        UPDATE messages
        SET is_recalled = true, content = '', revision = ${revision}
        WHERE message_id = ${input.messageId}
      `;
      await tx`
        INSERT INTO message_changes (
          revision, message_id, room_id, change_type, sender_id, content, reply_to_id, is_recalled, sent_at
        )
        SELECT revision, message_id, room_id, 'recalled', sender_id, content, reply_to_id, is_recalled, sent_at
        FROM messages WHERE message_id = ${input.messageId}
      `;
      await tx`
        UPDATE message_commands
        SET message_id = ${input.messageId}, result_revision = ${revision}
        WHERE user_id = ${input.userId} AND command_id = ${input.commandId}
      `;
    });
    return {
      message: replayRevision
        ? await this.loadMessageAtRevision(replayRevision)
        : await this.loadMessage(input.messageId),
      replayed,
    };
  }

  async advanceReadPosition(
    userId: string,
    roomId: string,
    candidateMessageId: string,
  ): Promise<{ messageId: string; advanced: boolean }> {
    let result: { messageId: string; advanced: boolean } | undefined;
    await this.sql.begin(async (tx) => {
      const memberships = await tx<{
        role: string;
        last_read_id: string | null;
        last_read_sent_at: Date | string | null;
      }[]>`
        SELECT rm.role, rm.last_read_id, current_message.sent_at AS last_read_sent_at
        FROM room_members rm
        LEFT JOIN messages current_message ON current_message.message_id = rm.last_read_id
        WHERE rm.user_id = ${userId} AND rm.room_id = ${roomId}
        FOR UPDATE OF rm
      `;
      if (!memberships[0] || memberships[0].role === 'pending') {
        throw new RealtimeRepositoryError('FORBIDDEN');
      }
      const candidates = await tx<{ message_id: string; sent_at: Date | string }[]>`
        SELECT message_id, sent_at FROM messages
        WHERE message_id = ${candidateMessageId} AND room_id = ${roomId}
      `;
      if (!candidates[0]) throw new RealtimeRepositoryError('NOT_FOUND');

      const currentId = memberships[0].last_read_id;
      const currentTime = memberships[0].last_read_sent_at;
      const candidateTime = new Date(candidates[0].sent_at).getTime();
      const isNewer = !currentId
        || currentTime === null
        || candidateTime > new Date(currentTime).getTime()
        || (candidateTime === new Date(currentTime).getTime() && candidateMessageId > currentId);

      if (isNewer) {
        await tx`
          UPDATE room_members SET last_read_id = ${candidateMessageId}
          WHERE user_id = ${userId} AND room_id = ${roomId}
        `;
        result = { messageId: candidateMessageId, advanced: true };
      } else {
        result = { messageId: currentId, advanced: false };
      }
    });
    return result!;
  }

  async getMessageDelta(
    userId: string,
    options: { cursor?: string; limit?: number } = {},
  ): Promise<MessageDeltaResult> {
    const memberships = await this.membershipScope(userId);
    const scopeHash = this.scopeHash(memberships);
    const decoded = options.cursor ? this.decodeCursor(options.cursor) : undefined;
    if (decoded && (decoded.userId !== userId || decoded.scopeHash !== scopeHash)) {
      throw new RealtimeRepositoryError('CURSOR_INVALID');
    }

    const highWaterRows = await this.sql<{ revision: bigint | string | number }[]>`
      SELECT COALESCE(MAX(revision), 0) AS revision FROM message_changes
    `;
    const currentHighWater = asRevision(highWaterRows[0].revision);
    const position = decoded?.position ?? '0';
    const highWater = !decoded || decoded.complete ? currentHighWater : decoded.highWater;
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);

    const rows = await this.sql<Array<MessageRow & { change_type: 'created' | 'updated' | 'recalled' }>>`
      SELECT
        mc.message_id,
        mc.room_id,
        mc.sender_id,
        mc.content,
        mc.reply_to_id,
        mc.is_recalled,
        mc.sent_at,
        mc.revision,
        mc.change_type,
        u.name AS sender_name,
        u.avatar_url AS sender_avatar_url
      FROM message_changes mc
      JOIN room_members rm
        ON rm.room_id = mc.room_id AND rm.user_id = ${userId} AND rm.role <> 'pending'
      JOIN chat_rooms room ON room.room_id = mc.room_id
      LEFT JOIN users u ON u.user_id = mc.sender_id
      WHERE mc.revision > ${position}::bigint
        AND mc.revision <= ${highWater}::bigint
        AND (room.view_history OR mc.sent_at >= rm.join_time)
      ORDER BY mc.revision ASC
      LIMIT ${limit + 1}
    `;

    const complete = rows.length <= limit;
    const page = rows.slice(0, limit);
    const extras = await this.loadMessageExtras(page.map((row) => row.message_id));
    const nextPosition = page.length > 0
      ? asRevision(page[page.length - 1].revision)
      : (complete ? highWater : position);
    const cursor = this.encodeCursor({
      version: 1,
      userId,
      scopeHash,
      position: complete ? highWater : nextPosition,
      highWater,
      complete,
    });
    return {
      changes: page.map((row) => ({
        type: `message.${row.change_type}` as 'message.created' | 'message.updated' | 'message.recalled',
        revision: asRevision(row.revision),
        message: { ...this.mapMessage(row), ...extras.get(row.message_id) },
      })),
      cursor,
      highWaterRevision: highWater,
      complete,
    };
  }

  async createEmergencyNotification(input: {
    sourceUserId: string;
    recipientId: string;
    idempotencyKey: string;
    message: string;
  }): Promise<{ notificationId: string; replayed: boolean; published: boolean }> {
    const inserted = await this.sql<{ notification_id: string }[]>`
      INSERT INTO emergency_notifications (source_user_id, recipient_id, idempotency_key, message)
      VALUES (${input.sourceUserId}, ${input.recipientId}, ${input.idempotencyKey}, ${input.message})
      ON CONFLICT (recipient_id, idempotency_key) DO NOTHING
      RETURNING notification_id
    `;
    if (inserted[0]) return {
      notificationId: inserted[0].notification_id,
      replayed: false,
      published: false,
    };
    const existing = await this.sql<{
      notification_id: string;
      source_user_id: string;
      message: string;
      delivery_state: 'pending' | 'published';
    }[]>`
      SELECT notification_id, source_user_id, message, delivery_state
      FROM emergency_notifications
      WHERE recipient_id = ${input.recipientId} AND idempotency_key = ${input.idempotencyKey}
    `;
    if (existing[0]?.source_user_id !== input.sourceUserId || existing[0]?.message !== input.message) {
      throw new RealtimeRepositoryError('IDEMPOTENCY_CONFLICT');
    }
    return {
      notificationId: existing[0].notification_id,
      replayed: true,
      published: existing[0].delivery_state === 'published',
    };
  }

  async markEmergencyNotificationPublished(notificationId: string): Promise<void> {
    await this.sql`
      UPDATE emergency_notifications
      SET delivery_state = 'published', published_at = COALESCE(published_at, NOW())
      WHERE notification_id = ${notificationId}
    `;
  }

  async listEmergencyNotifications(recipientId: string): Promise<Array<{
    notificationId: string;
    userId: string;
    message: string;
    createdAt: string;
  }>> {
    const rows = await this.sql<{
      notification_id: string;
      source_user_id: string;
      message: string;
      created_at: Date | string;
    }[]>`
      SELECT notification_id, source_user_id, message, created_at
      FROM emergency_notifications
      WHERE recipient_id = ${recipientId} AND acknowledged_at IS NULL
      ORDER BY created_at DESC, notification_id DESC
      LIMIT 20
    `;
    return rows.map((row) => ({
      notificationId: row.notification_id,
      userId: row.source_user_id,
      message: row.message,
      createdAt: asIso(row.created_at),
    }));
  }

  async acknowledgeEmergencyNotification(recipientId: string, notificationId: string): Promise<void> {
    await this.sql`
      UPDATE emergency_notifications
      SET acknowledged_at = COALESCE(acknowledged_at, NOW())
      WHERE notification_id = ${notificationId} AND recipient_id = ${recipientId}
    `;
  }

  private async loadMessage(messageId: string): Promise<RealtimeMessage> {
    const rows = await this.sql<MessageRow[]>`
      SELECT
        m.message_id,
        m.room_id,
        m.sender_id,
        m.content,
        m.reply_to_id,
        m.is_recalled,
        m.sent_at,
        m.revision,
        u.name AS sender_name,
        u.avatar_url AS sender_avatar_url
      FROM messages m
      LEFT JOIN users u ON u.user_id = m.sender_id
      WHERE m.message_id = ${messageId}
    `;
    if (!rows[0]) throw new RealtimeRepositoryError('NOT_FOUND');
    const extras = await this.loadMessageExtras([messageId]);
    return { ...this.mapMessage(rows[0]), ...extras.get(messageId) };
  }

  private async loadMessageAtRevision(revision: string): Promise<RealtimeMessage> {
    const rows = await this.sql<MessageRow[]>`
      SELECT
        mc.message_id,
        mc.room_id,
        mc.sender_id,
        mc.content,
        mc.reply_to_id,
        mc.is_recalled,
        mc.sent_at,
        mc.revision,
        u.name AS sender_name,
        u.avatar_url AS sender_avatar_url
      FROM message_changes mc
      LEFT JOIN users u ON u.user_id = mc.sender_id
      WHERE mc.revision = ${revision}::bigint
    `;
    if (!rows[0]) throw new RealtimeRepositoryError('NOT_FOUND');
    const current = await this.loadMessage(rows[0].message_id);
    return { ...current, ...this.mapMessage(rows[0]) };
  }

  private mapMessage(row: MessageRow): RealtimeMessage {
    return {
      messageId: row.message_id,
      roomId: row.room_id,
      senderId: row.sender_id,
      content: row.content,
      ...(row.reply_to_id ? { replyToId: row.reply_to_id } : {}),
      isRecalled: row.is_recalled,
      sentAt: asIso(row.sent_at),
      revision: asRevision(row.revision),
      sender: row.sender_id && row.sender_name
        ? {
            userId: row.sender_id,
            name: row.sender_name,
            ...(row.sender_avatar_url ? { avatarUrl: row.sender_avatar_url } : {}),
          }
        : null,
    };
  }

  private async loadMessageExtras(messageIds: string[]): Promise<Map<string, Partial<RealtimeMessage>>> {
    const uniqueIds = [...new Set(messageIds)];
    if (uniqueIds.length === 0) return new Map();
    const [mentions, attachments] = await Promise.all([
      this.sql<{ message_id: string; user_id: string }[]>`
        SELECT message_id, user_id
        FROM message_mentions
        WHERE message_id = ANY(${this.sql.array(uniqueIds, 'uuid')})
        ORDER BY message_id, user_id
      `,
      this.sql<AttachmentExtraRow[]>`
        SELECT message_id, attachment_id, uploaded_by, file_type, original_name, uploaded_at
        FROM attachments
        WHERE message_id = ANY(${this.sql.array(uniqueIds, 'uuid')})
        ORDER BY message_id, uploaded_at
      `,
    ]);

    const mentionMap = new Map<string, string[]>();
    for (const row of mentions) {
      const values = mentionMap.get(row.message_id) ?? [];
      values.push(row.user_id);
      mentionMap.set(row.message_id, values);
    }
    const attachmentMap = new Map<string, NonNullable<RealtimeMessage['attachments']>>();
    for (const row of attachments) {
      if (!row.uploaded_by) continue;
      const values = attachmentMap.get(row.message_id) ?? [];
      values.push({
        attachmentId: row.attachment_id,
        uploadedBy: row.uploaded_by,
        fileUrl: `/api/v1/attachments/${row.attachment_id}`,
        fileType: row.file_type,
        originalName: row.original_name,
        uploadedAt: asIso(row.uploaded_at),
      });
      attachmentMap.set(row.message_id, values);
    }

    return new Map(uniqueIds.map((messageId) => [messageId, {
      ...(mentionMap.has(messageId) ? { mentions: mentionMap.get(messageId)! } : {}),
      ...(attachmentMap.has(messageId) ? { attachments: attachmentMap.get(messageId)! } : {}),
    }]));
  }

  private async membershipScope(userId: string): Promise<MembershipScopeRow[]> {
    return this.sql<MembershipScopeRow[]>`
      SELECT rm.room_id, rm.membership_epoch, rm.join_time, room.view_history
      FROM room_members rm
      JOIN chat_rooms room ON room.room_id = rm.room_id
      WHERE rm.user_id = ${userId} AND rm.role <> 'pending'
      ORDER BY rm.room_id
    `;
  }

  private scopeHash(rows: MembershipScopeRow[]): string {
    return createHash('sha256')
      .update(rows.map((row) => `${row.room_id}:${row.membership_epoch}`).join('|'))
      .digest('hex');
  }

  private encodeCursor(cursor: DeltaCursor): string {
    const payload = Buffer.from(JSON.stringify(cursor)).toString('base64url');
    const signature = createHmac('sha256', this.cursorSecret).update(payload).digest('base64url');
    return `${payload}.${signature}`;
  }

  private decodeCursor(cursor: string): DeltaCursor {
    const [payload, signature, extra] = cursor.split('.');
    if (!payload || !signature || extra !== undefined) throw new RealtimeRepositoryError('CURSOR_INVALID');
    const expected = Buffer.from(createHmac('sha256', this.cursorSecret).update(payload).digest('base64url'));
    const actual = Buffer.from(signature);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      throw new RealtimeRepositoryError('CURSOR_INVALID');
    }
    try {
      const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as DeltaCursor;
      if (
        parsed.version !== 1
        || typeof parsed.userId !== 'string'
        || typeof parsed.scopeHash !== 'string'
        || !/^\d+$/.test(parsed.position)
        || !/^\d+$/.test(parsed.highWater)
        || typeof parsed.complete !== 'boolean'
      ) throw new Error('invalid');
      return parsed;
    } catch {
      throw new RealtimeRepositoryError('CURSOR_INVALID');
    }
  }
}
