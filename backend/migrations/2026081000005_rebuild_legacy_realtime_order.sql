-- Up Migration
-- 1000003 originally rebuilt every room. Repair only still-legacy rooms in
-- deployments that have not yet issued durable sequences there; never rewrite
-- an already durable sequence held by a client cursor.
LOCK TABLE messages, message_changes, room_members, realtime_counters IN ACCESS EXCLUSIVE MODE;

WITH legacy_rooms AS (
  SELECT room_id
  FROM messages
  GROUP BY room_id
  HAVING BOOL_AND(message_sequence = 0)
), ordered AS (
  SELECT m.message_id,
         ROW_NUMBER() OVER (
           PARTITION BY m.room_id
           ORDER BY m.sent_at, m.message_id
         ) AS next_sequence
  FROM messages m
  JOIN legacy_rooms lr ON lr.room_id = m.room_id
  WHERE m.message_sequence = 0
)
UPDATE messages m
SET message_sequence = ordered.next_sequence
FROM ordered
WHERE m.message_id = ordered.message_id;

UPDATE message_changes mc
SET message_sequence = m.message_sequence
FROM messages m
WHERE mc.message_id = m.message_id;

UPDATE room_members rm
SET join_boundary = COALESCE((
      SELECT MAX(m.message_sequence)
      FROM messages m
      WHERE m.room_id = rm.room_id
        AND m.sent_at < rm.join_time
    ), 0),
    read_position = COALESCE((
      SELECT m.message_sequence
      FROM messages m
      WHERE m.message_id = rm.last_read_id
    ), 0);

UPDATE realtime_counters
SET message_sequence = COALESCE((SELECT MAX(message_sequence) FROM messages), 0)
WHERE counter_id = true;

--- Down migration
SELECT 1;
