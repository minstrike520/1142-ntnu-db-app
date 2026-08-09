import { SQL } from "bun";
import defaultSql from "./db";
import type { Attachment, Message, MessageChange, MessageWithSender } from '@shared/types';
import type { IMessageRepository } from './IMessageRepository';
import { ConflictError, ForbiddenError, ValidationError } from '../utils/AppError';

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

interface MessageChangeRelationRow {
  attachment_id?: string;
  message_id?: string | null;
  uploaded_by?: string | null;
  file_type?: string;
  original_name?: string;
  uploaded_at?: string | Date;
}

type CommandAwareMessage = MessageWithSender & { __replayedCommand?: boolean };

const markCommandReplay = (message: MessageWithSender, replayed: boolean): MessageWithSender => {
  Object.defineProperty(message as CommandAwareMessage, '__replayedCommand', {
    value: replayed,
    enumerable: false,
  });
  return message;
};

const lockPrivateRoomPeer = async (tx: SQL, roomId: string, userId: string): Promise<void> => {
  const peers = await tx<{ user_id: string }[]>`
    SELECT other.user_id
    FROM chat_rooms cr
    JOIN room_members me ON me.room_id = cr.room_id AND me.user_id = ${userId}
    JOIN room_members other ON other.room_id = cr.room_id AND other.user_id <> ${userId}
    WHERE cr.room_id = ${roomId}
      AND cr.type = 'private'
      AND other.role <> 'pending'
    LIMIT 1
  `;
  if (peers.length === 0) return;
  const pairKey = [userId, peers[0].user_id].sort().join(':');
  await tx`
    SELECT pg_advisory_xact_lock(hashtextextended(${pairKey}, 1))
  `;
};

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

function mapSnapshotAttachments(value: unknown): Attachment[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const row = item as MessageChangeRelationRow;
    if (!row.attachment_id || !row.file_type || !row.original_name || !row.uploaded_at) return [];
    return [mapRowToAttachment({
      attachment_id: row.attachment_id,
      message_id: row.message_id,
      uploaded_by: row.uploaded_by ?? null,
      file_type: row.file_type,
      original_name: row.original_name,
      uploaded_at: new Date(row.uploaded_at),
    })];
  });
}

function mapSnapshotMentions(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((userId): userId is string => typeof userId === 'string');
  }
  if (typeof value !== 'string' || value.length < 2) return [];
  return value
    .slice(1, -1)
    .split(',')
    .map((userId) => userId.trim())
    .filter(Boolean);
}

function mapRowToMessage(row: MessageRow | MessageWithSenderRow): Message {
  return {
    messageId: row.message_id,
    roomId: row.room_id,
    senderId: row.sender_id,
    content: row.is_recalled ? '' : row.content,
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
  if (!row.is_recalled && row.mentions) {
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
      messageRows.map((row) => {
        const message = mapRowToMessageWithSender({
          ...row,
          mentions: mapSnapshotMentions(row.mentions),
          attachments: mapSnapshotAttachments(row.attachment_snapshot),
        });
        return [row.message_id, message] as const;
      }),
    );

    return messageIds
      .map((messageId) => messagesById.get(messageId))
      .filter((message): message is MessageWithSender => Boolean(message));
  }

  private async fetchChangeSnapshot(changeSequence: number, messageId: string): Promise<MessageWithSender> {
    const [message] = await this.fetchMessageWithSenderByIds([messageId]);
    const rows = await this.sql<Array<{
      content: string;
      reply_to_id: string | null;
      is_recalled: boolean;
      sent_at: Date;
      message_sequence: number | string;
      change_sequence: number | string;
      revision: number;
      mentions: unknown;
      attachments: unknown;
    }>>`
      SELECT content, reply_to_id, is_recalled, sent_at,
             message_sequence, change_sequence, revision, mentions, attachments
      FROM message_changes
      WHERE change_sequence = ${changeSequence} AND message_id = ${messageId}
    `;
    if (!message || rows.length === 0) throw new Error('Message change snapshot not found');
    const snapshot = rows[0];
    return {
      ...message,
      content: snapshot.is_recalled ? '' : snapshot.content,
      replyToId: snapshot.reply_to_id ?? undefined,
      isRecalled: snapshot.is_recalled,
      sentAt: snapshot.sent_at,
      messageSequence: Number(snapshot.message_sequence),
      changeSequence: Number(snapshot.change_sequence),
      revision: snapshot.revision,
      mentions: !snapshot.is_recalled && Array.isArray(snapshot.mentions)
        ? snapshot.mentions.filter((userId): userId is string => typeof userId === 'string')
        : [],
      attachments: snapshot.is_recalled ? undefined : mapSnapshotAttachments(snapshot.attachments),
    };
  }

  async findById(messageId: string): Promise<Message | null> {
    const rows = await this.sql<MessageRow[]>`
      SELECT * FROM messages WHERE message_id = ${messageId}
    `;
    return rows.length === 0 ? null : mapRowToMessage(rows[0]);
  }

  async findByRoom(roomId: string, opts: { beforeId?: string; limit: number; after?: Date; afterSequence?: number }): Promise<MessageWithSender[]> {
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

  async create(data: Pick<Message, 'roomId' | 'senderId' | 'content' | 'replyToId'> & { mentions?: string[], attachmentIds?: string[], commandId?: string }): Promise<MessageWithSender> {
    let createdMessageId: string = '';
    let replayedCommand = false;
    let responseChangeSequence: number | undefined;

    await this.sql.begin(async (tx) => {
      let authorization: Array<{
        role: string;
        is_muted: boolean;
        is_archived: boolean;
        is_readonly: boolean;
        is_blocked: boolean;
        view_history: boolean;
        join_boundary: number | string;
        join_time: Date;
      }> = [];
      if (data.senderId) {
        await lockPrivateRoomPeer(tx, data.roomId, data.senderId);
        authorization = await tx<{
          role: string;
          is_muted: boolean;
          is_archived: boolean;
          is_readonly: boolean;
          is_blocked: boolean;
          view_history: boolean;
          join_boundary: number | string;
          join_time: Date;
        }[]>`
        SELECT rm.role, rm.is_muted, cr.is_archived, cr.is_readonly,
               cr.view_history, rm.join_boundary, rm.join_time,
               EXISTS (
                 SELECT 1
                 FROM room_members other
                 JOIN blocks b ON (
                   (b.blocker_id = ${data.senderId} AND b.blocked_id = other.user_id)
                   OR (b.blocker_id = other.user_id AND b.blocked_id = ${data.senderId})
                 )
                 WHERE other.room_id = rm.room_id
                   AND other.user_id <> ${data.senderId}
                   AND other.role <> 'pending'
               ) AS is_blocked
        FROM room_members rm
          JOIN chat_rooms cr ON cr.room_id = rm.room_id
          WHERE rm.room_id = ${data.roomId} AND rm.user_id = ${data.senderId}
          FOR NO KEY UPDATE
        `;
        if (authorization.length === 0 || authorization[0].role === 'pending') {
          throw new ForbiddenError('User is not an active member of this room');
        }
        if (authorization[0].is_archived) throw new ForbiddenError('This room is archived');
        if (authorization[0].is_readonly) throw new ForbiddenError('This room is read-only');
        if (authorization[0].is_muted) throw new ForbiddenError('Muted members cannot send messages');
        if (authorization[0].is_blocked) throw new ForbiddenError('Blocked users cannot access this room');
      }

      if (data.replyToId) {
        const replyTarget = await tx<{ room_id: string; message_sequence: number | string; sent_at: Date }[]>`
          SELECT message_sequence, sent_at, room_id
          FROM messages
          WHERE message_id = ${data.replyToId}
        `;
        if (replyTarget.length === 0 || replyTarget[0].room_id !== data.roomId) {
          throw new ValidationError('Reply target must belong to this room');
        }
        const auth = authorization[0];
        if (
          data.senderId
          && auth
          && !auth.view_history
          && !(
            Number(replyTarget[0].message_sequence) > Number(auth.join_boundary)
            || (
              Number(replyTarget[0].message_sequence) === 0
              && replyTarget[0].sent_at >= auth.join_time
            )
          )
        ) {
          throw new ForbiddenError('Reply target is outside the room visibility boundary');
        }
      }

      if (data.commandId && data.senderId) {
        // Create, edit, and recall share one idempotency namespace. Serialize
        // the lookup with the other durable commands so a key reused across
        // operations becomes a stable conflict rather than a raw 23505.
        await tx`
          SELECT pg_advisory_xact_lock(hashtextextended(${`${data.senderId}:${data.commandId}`}, 0))
        `;
        const prior = await tx<{ message_id: string; change_type: string; change_sequence: number | string }[]>`
          SELECT message_id, change_type, change_sequence
          FROM message_changes
          WHERE actor_id = ${data.senderId} AND command_id = ${data.commandId}
          ORDER BY change_sequence ASC
          LIMIT 1
        `;
        if (prior.length > 0) {
          if (prior[0].change_type !== 'created') {
            throw new ConflictError('Idempotency-Key was already used for another operation');
          }
          createdMessageId = prior[0].message_id;
          responseChangeSequence = Number(prior[0].change_sequence);
          replayedCommand = true;
          return;
        }
      }

      const rows = await tx<{ message_id: string; change_sequence: number | string }[]>`
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
        RETURNING message_id, change_sequence
      `;
      if (rows.length === 0) {
        const existing = await tx<{ message_id: string; change_sequence: number | string }[]>`
          SELECT m.message_id, mc.change_sequence
          FROM messages m
          JOIN message_changes mc ON mc.message_id = m.message_id AND mc.change_type = 'created'
          WHERE m.sender_id = ${data.senderId} AND m.command_id = ${data.commandId}
          ORDER BY mc.change_sequence ASC
          LIMIT 1
        `;
        if (existing.length === 0) throw new ConflictError('The message command could not be applied');
        createdMessageId = existing[0].message_id;
        responseChangeSequence = Number(existing[0].change_sequence);
        replayedCommand = true;
        return;
      }
      createdMessageId = rows[0].message_id;
      responseChangeSequence = Number(rows[0].change_sequence);

      await tx`
        UPDATE realtime_counters
        SET message_sequence = message_sequence + 1,
            change_sequence = change_sequence + 1
        WHERE counter_id = true
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
          WHERE attachment_id = ANY(${pgAttIds}::uuid[])
            AND message_id IS NULL
            AND uploaded_by = ${data.senderId}
          RETURNING attachment_id
        `;
        if (updatedAtts.length !== new Set(data.attachmentIds).size) {
          throw new ValidationError('Attachments must exist and must not already belong to a message');
        }
      }

      await tx`
        INSERT INTO message_changes (
          change_sequence, message_id, room_id, message_sequence, revision,
          change_type, actor_id, command_id, sender_id, content, is_recalled,
          reply_to_id, sent_at, mentions, attachments
        )
        SELECT m.change_sequence, m.message_id, m.room_id, m.message_sequence,
          m.revision, 'created', m.sender_id, ${data.commandId ?? null},
          m.sender_id, m.content, m.is_recalled, m.reply_to_id, m.sent_at,
          COALESCE((
            SELECT jsonb_agg(mm.user_id ORDER BY mm.user_id)
            FROM message_mentions mm
            WHERE mm.message_id = m.message_id
          ), '[]'::jsonb),
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
            WHERE a.message_id = m.message_id
          ), '[]'::jsonb)
        FROM messages m
        WHERE m.message_id = ${createdMessageId}
      `;
    });

    const message = responseChangeSequence !== undefined
      ? await this.fetchChangeSnapshot(responseChangeSequence, createdMessageId)
      : (await this.fetchMessageWithSenderByIds([createdMessageId]))[0];
    return markCommandReplay(message, replayedCommand);
  }

  async markRecalled(messageId: string, expectedRevision?: number, commandId?: string, actorId?: string): Promise<MessageWithSender> {
    let replayedCommand = false;
    let responseChangeSequence: number | undefined;
    await this.sql.begin(async (tx) => {
      if (commandId && actorId) {
        // Serialize the same actor/key even when concurrent requests target
        // different messages; the unique receipt index then remains a clean
        // idempotency result instead of surfacing a raw 23505 error.
        await tx`
          SELECT pg_advisory_xact_lock(hashtextextended(${`${actorId}:${commandId}`}, 0))
        `;
      }

      const current = await tx<MessageRow[]>`
        SELECT * FROM messages WHERE message_id = ${messageId} FOR NO KEY UPDATE
      `;
      if (current.length === 0) throw new Error('Message not found');

      if (actorId) {
        await lockPrivateRoomPeer(tx, current[0].room_id, actorId);
        const authorization = await tx<{ actor_role: string; is_archived: boolean; is_readonly: boolean; is_blocked: boolean }[]>`
          SELECT actor.role AS actor_role, cr.is_archived, cr.is_readonly,
                 EXISTS (
                   SELECT 1
                   FROM room_members other
                   JOIN blocks b ON (
                     (b.blocker_id = ${actorId} AND b.blocked_id = other.user_id)
                     OR (b.blocker_id = other.user_id AND b.blocked_id = ${actorId})
                   )
                   WHERE other.room_id = actor.room_id
                     AND other.user_id <> ${actorId}
                     AND other.role <> 'pending'
                 ) AS is_blocked
          FROM messages m
          JOIN chat_rooms cr ON cr.room_id = m.room_id
          JOIN room_members actor ON actor.room_id = m.room_id AND actor.user_id = ${actorId}
          WHERE m.message_id = ${messageId}
          FOR NO KEY UPDATE OF cr, actor
        `;
        const auth = authorization[0];
        if (!auth || auth.actor_role === 'pending') throw new ForbiddenError('User is not an active member of this room');
        if (auth.is_archived) throw new ForbiddenError('This room is archived');
        if (auth.is_readonly) throw new ForbiddenError('This room is read-only');
        if (auth.is_blocked) throw new ForbiddenError('Blocked users cannot access this room');
        const canRecall = current[0].sender_id === actorId || auth.actor_role === 'owner' || auth.actor_role === 'admin';
        if (!canRecall) throw new ForbiddenError('Only the original sender or an admin can recall this message');
        if (auth.actor_role === 'admin' && current[0].sender_id && current[0].sender_id !== actorId) {
          const senderRows = await tx<{ role: string }[]>`
            SELECT role FROM room_members
            WHERE room_id = ${current[0].room_id} AND user_id = ${current[0].sender_id}
            FOR UPDATE
          `;
          if (senderRows[0]?.role === 'owner' || senderRows[0]?.role === 'admin') {
            throw new ForbiddenError('Admins cannot recall messages from the room owner or other admins');
          }
        }
      }

      // Lock the message before checking the receipt. A concurrent retry of
      // the same command must observe the first transaction's receipt after
      // waiting for that lock, rather than failing on the unique index.
      if (commandId && actorId) {
        const prior = await tx<{ message_id: string; change_type: string; change_sequence: number | string }[]>`
          SELECT message_id, change_type, change_sequence FROM message_changes
          WHERE actor_id = ${actorId} AND command_id = ${commandId}
          ORDER BY change_sequence DESC LIMIT 1
        `;
        if (prior.length > 0) {
          if (prior[0].message_id !== messageId) throw new ConflictError('Idempotency-Key was already used for another message');
          if (prior[0].change_type !== 'recalled') throw new ConflictError('Idempotency-Key was already used for another operation');
          responseChangeSequence = Number(prior[0].change_sequence);
          replayedCommand = true;
          return;
        }
      }

      if (expectedRevision !== undefined && Number(current[0].revision) !== expectedRevision) {
        throw new ConflictError('Message revision is stale');
      }
      if (current[0].is_recalled) {
        // A durable retry (or a second recall command) is a no-op and must not
        // publish a fresh event when no new Message Change was committed.
        replayedCommand = Boolean(commandId && actorId);
        return;
      }

      const next = await tx<{ change_sequence: number | string }[]>`
        UPDATE realtime_counters
        SET change_sequence = change_sequence + 1
        WHERE counter_id = true
        RETURNING change_sequence
      `;
      const changeSequence = next[0].change_sequence;
      responseChangeSequence = Number(changeSequence);
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
          reply_to_id, sent_at, mentions, attachments
        )
        SELECT ${changeSequence}, message_id, room_id, message_sequence,
          revision, 'recalled', ${actorId ?? null}, ${commandId ?? null},
          sender_id, content, true, reply_to_id, sent_at,
          COALESCE((
            SELECT jsonb_agg(mm.user_id ORDER BY mm.user_id)
            FROM message_mentions mm
            WHERE mm.message_id = messages.message_id
          ), '[]'::jsonb),
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
            WHERE a.message_id = messages.message_id
          ), '[]'::jsonb)
        FROM messages WHERE message_id = ${messageId}
      `;
    });
    const message = responseChangeSequence !== undefined
      ? await this.fetchChangeSnapshot(responseChangeSequence, messageId)
      : (await this.fetchMessageWithSenderByIds([messageId]))[0];
    return markCommandReplay(message, replayedCommand);
  }

  async update(messageId: string, content: string, mentions?: string[], expectedRevision?: number, commandId?: string, actorId?: string): Promise<MessageWithSender> {
    let replayedCommand = false;
    let responseChangeSequence: number | undefined;
    await this.sql.begin(async (tx) => {
      if (commandId && actorId) {
        await tx`
          SELECT pg_advisory_xact_lock(hashtextextended(${`${actorId}:${commandId}`}, 0))
        `;
      }

      const rows = await tx<MessageRow[]>`
        SELECT * FROM messages WHERE message_id = ${messageId} FOR NO KEY UPDATE
      `;
      if (rows.length === 0) {
        throw new Error('Message not found');
      }

      if (actorId) {
        await lockPrivateRoomPeer(tx, rows[0].room_id, actorId);
        const authorization = await tx<{ actor_role: string; actor_muted: boolean; is_archived: boolean; is_readonly: boolean; is_blocked: boolean }[]>`
          SELECT actor.role AS actor_role, actor.is_muted AS actor_muted,
                 cr.is_archived, cr.is_readonly,
                 EXISTS (
                   SELECT 1
                   FROM room_members other
                   JOIN blocks b ON (
                     (b.blocker_id = ${actorId} AND b.blocked_id = other.user_id)
                     OR (b.blocker_id = other.user_id AND b.blocked_id = ${actorId})
                   )
                   WHERE other.room_id = actor.room_id
                     AND other.user_id <> ${actorId}
                     AND other.role <> 'pending'
                 ) AS is_blocked
          FROM messages m
          JOIN chat_rooms cr ON cr.room_id = m.room_id
          JOIN room_members actor ON actor.room_id = m.room_id AND actor.user_id = ${actorId}
          WHERE m.message_id = ${messageId}
          FOR NO KEY UPDATE OF cr, actor
        `;
        const auth = authorization[0];
        if (!auth || auth.actor_role === 'pending') throw new ForbiddenError('User is not an active member of this room');
        if (auth.is_archived) throw new ForbiddenError('This room is archived');
        if (auth.is_readonly) throw new ForbiddenError('This room is read-only');
        if (auth.is_blocked) throw new ForbiddenError('Blocked users cannot access this room');
        if (auth.actor_muted) throw new ForbiddenError('Muted members cannot update messages');
        if (rows[0].sender_id !== actorId) throw new ForbiddenError('Only the original sender can edit this message');
      }

      // See markRecalled: the row lock serializes concurrent retries so the
      // second request can return the already-recorded canonical change.
      if (commandId && actorId) {
        const prior = await tx<{ message_id: string; change_type: string; change_sequence: number | string }[]>`
          SELECT message_id, change_type, change_sequence FROM message_changes
          WHERE actor_id = ${actorId} AND command_id = ${commandId}
          ORDER BY change_sequence DESC LIMIT 1
        `;
        if (prior.length > 0) {
          if (prior[0].message_id !== messageId) throw new ConflictError('Idempotency-Key was already used for another message');
          if (prior[0].change_type !== 'edited') throw new ConflictError('Idempotency-Key was already used for another operation');
          responseChangeSequence = Number(prior[0].change_sequence);
          replayedCommand = true;
          return;
        }
      }

      if (expectedRevision !== undefined && Number(rows[0].revision) !== expectedRevision) {
        throw new ConflictError('Message revision is stale');
      }
      if (rows[0].is_recalled) {
        throw new ValidationError('Cannot edit a recalled message');
      }

      const next = await tx<{ change_sequence: number | string }[]>`
        UPDATE realtime_counters
        SET change_sequence = change_sequence + 1
        WHERE counter_id = true
        RETURNING change_sequence
      `;
      const changeSequence = next[0].change_sequence;
      responseChangeSequence = Number(changeSequence);
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
          reply_to_id, sent_at, mentions, attachments
        )
        SELECT ${changeSequence}, message_id, room_id, message_sequence,
          revision, 'edited', ${actorId ?? null}, ${commandId ?? null},
          sender_id, content, is_recalled, reply_to_id, sent_at,
          COALESCE((
            SELECT jsonb_agg(mm.user_id ORDER BY mm.user_id)
            FROM message_mentions mm
            WHERE mm.message_id = messages.message_id
          ), '[]'::jsonb),
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
            WHERE a.message_id = messages.message_id
          ), '[]'::jsonb)
        FROM messages WHERE message_id = ${messageId}
      `;
    });

    const message = responseChangeSequence !== undefined
      ? await this.fetchChangeSnapshot(responseChangeSequence, messageId)
      : (await this.fetchMessageWithSenderByIds([messageId]))[0];
    return markCommandReplay(message, replayedCommand);
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

    return rows.map((row) => {
      const isDeleted = row.sender_deleted_at !== null;
      const isRecalled = row.is_recalled || row.current_is_recalled;
      const message: MessageWithSender = {
        messageId: row.message_id,
        roomId: row.room_id,
        senderId: row.sender_id,
        content: isRecalled ? '' : row.content,
        replyToId: row.reply_to_id ?? undefined,
        isRecalled,
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
      if (!isRecalled) {
        message.attachments = mapSnapshotAttachments(row.attachments);
      }
      message.mentions = !isRecalled && Array.isArray(row.mentions)
        ? row.mentions.filter((userId): userId is string => typeof userId === 'string')
        : [];
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
