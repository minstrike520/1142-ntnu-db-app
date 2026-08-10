-- Up Migration
-- 2026081000003 is additive and may already have run in a deployment before
-- this cursor reconciliation was shipped. Repeat the idempotent member
-- updates so both upgrade paths preserve the old visibility/read semantics.
UPDATE room_members rm
SET join_boundary = GREATEST(
      rm.join_boundary,
      COALESCE((
        SELECT MAX(m.message_sequence)
        FROM messages m
        JOIN chat_rooms cr ON cr.room_id = m.room_id
        WHERE m.room_id = rm.room_id
          AND NOT cr.view_history
          AND m.sent_at < rm.join_time
      ), 0)
    ),
    read_position = GREATEST(
      rm.read_position,
      COALESCE((
        SELECT m.message_sequence
        FROM messages m
        WHERE m.message_id = rm.last_read_id
      ), 0)
    );

--- Down migration
SELECT 1;
