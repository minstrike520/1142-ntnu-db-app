import { SQL } from 'bun';
import type { Message, MessageWithSender } from '@shared/types';
import { ConflictError, ForbiddenError, ValidationError } from '../../utils/AppError';
import { commandLockKey, findCommandReceipts, resolveCommandReceipt } from './commandIdempotency';
import type { MessageQueries } from './messageQueries';
import type { MessageChangeQueries } from './messageChangeQueries';
import type { AttachmentSnapshotRow, MessageRow } from './mappers';

const markCommandReplay = (message: MessageWithSender, replayed: boolean): MessageWithSender => {
  Object.defineProperty(message as MessageWithSender & { __replayedCommand?: boolean }, '__replayedCommand', {
    value: replayed,
    enumerable: false,
  });
  return message;
};

export const lockPrivateRoomPeer = async (tx: SQL, roomId: string, userId: string): Promise<void> => {
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

export const runMessageTransaction = async <T>(
  sql: SQL,
  work: (tx: SQL) => Promise<T>,
): Promise<T> => sql.begin(work);

export class MessageCommands {
  constructor(
    private readonly sql: SQL,
    private readonly queries: MessageQueries,
    private readonly changes: MessageChangeQueries,
  ) {}

  async create(data: Pick<Message, 'roomId' | 'senderId' | 'content' | 'replyToId'> & { mentions?: string[], attachmentIds?: string[], commandId?: string }): Promise<MessageWithSender> {
    let createdMessageId: string = '';
    let replayedCommand = false;
    let responseChangeSequence: number | undefined;

    await runMessageTransaction(this.sql, async (tx) => {
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
          SELECT pg_advisory_xact_lock(hashtextextended(${commandLockKey(data.senderId, data.commandId)}, 0))
        `;
        const resolution = resolveCommandReceipt(
          await findCommandReceipts(tx, data.senderId, data.commandId),
          'created',
        );
        if (resolution.kind === 'conflict') throw new ConflictError(resolution.message);
        if (resolution.kind === 'replay') {
          createdMessageId = resolution.messageId;
          responseChangeSequence = resolution.changeSequence;
          replayedCommand = true;
          return;
        }
      }

      // Everything that can be validated without the global counter is done
      // before it is touched. Claiming the attachments here takes only the
      // per-attachment row locks and leaves the rows pinned for the write
      // below, so the counter's critical section does not have to pay for it.
      const uniqueAttachmentIds = data.attachmentIds ? [...new Set(data.attachmentIds)] : [];
      let attachmentSnapshot: AttachmentSnapshotRow[] = [];
      if (uniqueAttachmentIds.length > 0) {
        const pgAttIds = `{${uniqueAttachmentIds.join(',')}}`;
        attachmentSnapshot = await tx<AttachmentSnapshotRow[]>`
          SELECT attachment_id, uploaded_by, file_type, original_name, uploaded_at
          FROM attachments
          WHERE attachment_id = ANY(${pgAttIds}::uuid[])
            AND message_id IS NULL
            AND uploaded_by = ${data.senderId}
          ORDER BY uploaded_at, attachment_id
          FOR UPDATE
        `;
        if (attachmentSnapshot.length !== uniqueAttachmentIds.length) {
          throw new ValidationError('Attachments must exist and must not already belong to a message');
        }
      }
      const uniqueMentions = data.mentions ? [...new Set(data.mentions)].sort() : [];

      // One statement holds the counter row lock, and it is the last write of
      // the transaction. Postgres keeps a row lock until commit, so the only
      // way to stop every message, membership and role write in the process
      // from serializing behind this row is to keep the window between taking
      // the lock and committing as small as a single round trip. The change
      // snapshot is therefore built from values already known here rather than
      // by re-reading the rows the sibling CTEs have just written — a CTE
      // cannot see its siblings' output.
      const pgMentionIds = `{${uniqueMentions.join(',')}}`;
      const pgClaimedAttachmentIds = `{${attachmentSnapshot.map((row) => row.attachment_id).join(',')}}`;
      const attachmentsJson = JSON.stringify(attachmentSnapshot.map((row) => ({
        attachment_id: row.attachment_id,
        uploaded_by: row.uploaded_by,
        file_type: row.file_type,
        original_name: row.original_name,
        uploaded_at: row.uploaded_at,
      })));
      const rows = await tx<{ message_id: string; change_sequence: number | string }[]>`
        WITH seq AS (
          UPDATE realtime_counters
          SET message_sequence = message_sequence + 1,
              change_sequence = change_sequence + 1
          WHERE counter_id = true
            AND NOT EXISTS (
              SELECT 1 FROM messages
              WHERE sender_id = ${data.senderId} AND command_id = ${data.commandId ?? null}
            )
          RETURNING message_sequence, change_sequence
        ),
        created AS (
          INSERT INTO messages (
            room_id, sender_id, content, reply_to_id, message_sequence, change_sequence, revision, command_id
          )
          SELECT
            ${data.roomId}, ${data.senderId}, ${data.content}, ${data.replyToId ?? null},
            seq.message_sequence,
            seq.change_sequence,
            1,
            ${data.commandId ?? null}
          FROM seq
          ON CONFLICT (sender_id, command_id) WHERE command_id IS NOT NULL DO NOTHING
          RETURNING message_id, room_id, sender_id, content, reply_to_id,
                    is_recalled, sent_at, message_sequence, change_sequence, revision
        ),
        mentioned AS (
          INSERT INTO message_mentions (message_id, user_id)
          SELECT created.message_id, mention
          FROM created
          CROSS JOIN unnest(${pgMentionIds}::uuid[]) AS mention
          RETURNING user_id
        ),
        claimed AS (
          UPDATE attachments a
          SET message_id = created.message_id
          FROM created
          WHERE a.attachment_id = ANY(${pgClaimedAttachmentIds}::uuid[])
            AND a.message_id IS NULL
          RETURNING a.attachment_id
        )
        INSERT INTO message_changes (
          change_sequence, message_id, room_id, message_sequence, revision,
          change_type, actor_id, command_id, sender_id, content, is_recalled,
          reply_to_id, sent_at, mentions, attachments
        )
        SELECT created.change_sequence, created.message_id, created.room_id,
          created.message_sequence, created.revision, 'created', created.sender_id,
          ${data.commandId ?? null}, created.sender_id, created.content,
          created.is_recalled, created.reply_to_id, created.sent_at,
          ${JSON.stringify(uniqueMentions)}::text::jsonb,
          COALESCE((
            SELECT jsonb_agg(
              entry || jsonb_build_object('message_id', created.message_id)
              ORDER BY entry_order
            )
            FROM jsonb_array_elements(${attachmentsJson}::text::jsonb)
              WITH ORDINALITY AS claimed_attachment(entry, entry_order)
          ), '[]'::jsonb)
        FROM created
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
    });

    const message = responseChangeSequence !== undefined
      ? await this.changes.fetchChangeSnapshot(responseChangeSequence, createdMessageId)
      : (await this.queries.fetchMessageWithSenderByIds([createdMessageId]))[0];
    return markCommandReplay(message, replayedCommand);
  }

  async markRecalled(messageId: string, expectedRevision?: number, commandId?: string, actorId?: string): Promise<MessageWithSender> {
    let replayedCommand = false;
    let responseChangeSequence: number | undefined;
    await runMessageTransaction(this.sql, async (tx) => {
      if (commandId && actorId) {
        // Serialize the same actor/key even when concurrent requests target
        // different messages; the unique receipt index then remains a clean
        // idempotency result instead of surfacing a raw 23505 error.
        await tx`
          SELECT pg_advisory_xact_lock(hashtextextended(${commandLockKey(actorId, commandId)}, 0))
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
        const resolution = resolveCommandReceipt(
          await findCommandReceipts(tx, actorId, commandId),
          'recalled',
          messageId,
        );
        if (resolution.kind === 'conflict') throw new ConflictError(resolution.message);
        if (resolution.kind === 'replay') {
          responseChangeSequence = resolution.changeSequence;
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
        //
        // It still consumed the key, though. Without a receipt the caller could
        // hand the same Idempotency-Key to a create or an edit afterwards and
        // have it accepted, because the cross-operation checks read receipts
        // out of `message_changes` and a no-op writes none. Record it in the
        // side table the lookup above also reads, pointing at the recall this
        // command converged on.
        if (commandId && actorId) {
          await tx`
            INSERT INTO message_command_receipts (
              actor_id, command_id, message_id, change_type, change_sequence
            )
            VALUES (
              ${actorId}, ${commandId}, ${messageId}, 'recalled',
              (
                SELECT change_sequence FROM message_changes
                WHERE message_id = ${messageId} AND change_type = 'recalled'
                ORDER BY change_sequence DESC LIMIT 1
              )
            )
            ON CONFLICT (actor_id, command_id) DO NOTHING
          `;
          replayedCommand = true;
        }
        return;
      }

      // One statement, and the last write of the transaction: the counter row
      // lock is what serializes every durable write in the process, so it is
      // taken as late as possible and released at the commit that follows.
      const next = await tx<{ change_sequence: number | string }[]>`
        WITH seq AS (
          UPDATE realtime_counters
          SET change_sequence = change_sequence + 1
          WHERE counter_id = true
          RETURNING change_sequence
        ),
        recalled AS (
          UPDATE messages
          SET is_recalled = true,
              change_sequence = seq.change_sequence,
              revision = messages.revision + 1
          FROM seq
          WHERE messages.message_id = ${messageId}
          RETURNING messages.message_id, messages.room_id, messages.message_sequence,
                    messages.revision, messages.sender_id, messages.content,
                    messages.reply_to_id, messages.sent_at, messages.change_sequence
        )
        INSERT INTO message_changes (
          change_sequence, message_id, room_id, message_sequence, revision,
          change_type, actor_id, command_id, sender_id, content, is_recalled,
          reply_to_id, sent_at, mentions, attachments
        )
        SELECT recalled.change_sequence, recalled.message_id, recalled.room_id,
          recalled.message_sequence, recalled.revision, 'recalled', ${actorId ?? null},
          ${commandId ?? null}, recalled.sender_id, recalled.content, true,
          recalled.reply_to_id, recalled.sent_at,
          COALESCE((
            SELECT jsonb_agg(mm.user_id ORDER BY mm.user_id)
            FROM message_mentions mm
            WHERE mm.message_id = recalled.message_id
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
            WHERE a.message_id = recalled.message_id
          ), '[]'::jsonb)
        FROM recalled
        RETURNING change_sequence
      `;
      responseChangeSequence = Number(next[0].change_sequence);
    });
    const message = responseChangeSequence !== undefined
      ? await this.changes.fetchChangeSnapshot(responseChangeSequence, messageId)
      : (await this.queries.fetchMessageWithSenderByIds([messageId]))[0];
    return markCommandReplay(message, replayedCommand);
  }

  async update(messageId: string, content: string, mentions?: string[], expectedRevision?: number, commandId?: string, actorId?: string): Promise<MessageWithSender> {
    let replayedCommand = false;
    let responseChangeSequence: number | undefined;
    await runMessageTransaction(this.sql, async (tx) => {
      if (commandId && actorId) {
        await tx`
          SELECT pg_advisory_xact_lock(hashtextextended(${commandLockKey(actorId, commandId)}, 0))
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
        const resolution = resolveCommandReceipt(
          await findCommandReceipts(tx, actorId, commandId),
          'edited',
          messageId,
        );
        if (resolution.kind === 'conflict') throw new ConflictError(resolution.message);
        if (resolution.kind === 'replay') {
          responseChangeSequence = resolution.changeSequence;
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

      // The mention set is rewritten before the counter is touched. These rows
      // do not depend on the new sequence, and anything executed while the
      // counter row is locked blocks every other durable write in the process.
      await tx`DELETE FROM message_mentions WHERE message_id = ${messageId}`;
      const uniqueMentions = mentions ? [...new Set(mentions)] : [];
      if (uniqueMentions.length > 0) {
        const pgMentionIds = `{${uniqueMentions.join(',')}}`;
        await tx`
          INSERT INTO message_mentions (message_id, user_id)
          SELECT ${messageId}, mention
          FROM unnest(${pgMentionIds}::uuid[]) AS mention
        `;
      }

      // Allocating the sequence, applying the edit and recording the snapshot
      // is one statement and the last write of the transaction, so the counter
      // row lock is released a single round trip later at commit.
      const next = await tx<{ change_sequence: number | string }[]>`
        WITH seq AS (
          UPDATE realtime_counters
          SET change_sequence = change_sequence + 1
          WHERE counter_id = true
          RETURNING change_sequence
        ),
        edited AS (
          UPDATE messages
          SET content = ${content},
              change_sequence = seq.change_sequence,
              revision = messages.revision + 1
          FROM seq
          WHERE messages.message_id = ${messageId}
          RETURNING messages.message_id, messages.room_id, messages.message_sequence,
                    messages.revision, messages.sender_id, messages.content,
                    messages.is_recalled, messages.reply_to_id, messages.sent_at,
                    messages.change_sequence
        )
        INSERT INTO message_changes (
          change_sequence, message_id, room_id, message_sequence, revision,
          change_type, actor_id, command_id, sender_id, content, is_recalled,
          reply_to_id, sent_at, mentions, attachments
        )
        SELECT edited.change_sequence, edited.message_id, edited.room_id,
          edited.message_sequence, edited.revision, 'edited', ${actorId ?? null},
          ${commandId ?? null}, edited.sender_id, edited.content,
          edited.is_recalled, edited.reply_to_id, edited.sent_at,
          COALESCE((
            SELECT jsonb_agg(mm.user_id ORDER BY mm.user_id)
            FROM message_mentions mm
            WHERE mm.message_id = edited.message_id
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
            WHERE a.message_id = edited.message_id
          ), '[]'::jsonb)
        FROM edited
        RETURNING change_sequence
      `;
      responseChangeSequence = Number(next[0].change_sequence);
    });

    const message = responseChangeSequence !== undefined
      ? await this.changes.fetchChangeSnapshot(responseChangeSequence, messageId)
      : (await this.queries.fetchMessageWithSenderByIds([messageId]))[0];
    return markCommandReplay(message, replayedCommand);
  }

}
