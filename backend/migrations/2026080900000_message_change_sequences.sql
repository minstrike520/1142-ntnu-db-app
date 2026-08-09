--- Up migration
-- Message Sequence / Change Sequence / revision / idempotency key, plus the
-- sequence-based Join Boundary and Read Position on room_members.
--
-- Sequences are allocated from a counter row inside the writing transaction and
-- deliberately NOT from a PostgreSQL sequence: nextval() is not transactional, so
-- a transaction that draws a lower number may commit after one that drew a higher
-- number. A reader whose cursor has already advanced past the higher number would
-- then skip the lower one permanently, and silently. Locking a counter row makes
-- allocation order equal commit order, and a rollback releases the number again.

CREATE TABLE message_sequence_counter (
  counter_id  BOOLEAN PRIMARY KEY DEFAULT true CHECK (counter_id),
  current_seq BIGINT  NOT NULL DEFAULT 0
);

INSERT INTO message_sequence_counter (counter_id, current_seq) VALUES (true, 0);

-- Self-materialising so that a TRUNCATE in the test helpers cannot leave the
-- allocator without a row to lock.
CREATE FUNCTION next_message_seq() RETURNS BIGINT
LANGUAGE sql VOLATILE AS $$
  INSERT INTO message_sequence_counter AS c (counter_id, current_seq)
  VALUES (true, 1)
  ON CONFLICT (counter_id) DO UPDATE SET current_seq = c.current_seq + 1
  RETURNING c.current_seq;
$$;

ALTER TABLE messages
  ADD COLUMN message_seq       BIGINT,
  ADD COLUMN change_seq        BIGINT,
  ADD COLUMN revision          INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN client_command_id UUID;

-- Backfill in the existing keyset order, not physical order, so that existing
-- conversations keep the order they are currently paginated in.
WITH ordered AS (
  SELECT message_id, ROW_NUMBER() OVER (ORDER BY sent_at, message_id) AS rn
  FROM messages
)
UPDATE messages m
SET message_seq = ordered.rn,
    change_seq  = ordered.rn
FROM ordered
WHERE m.message_id = ordered.message_id;

UPDATE message_sequence_counter
SET current_seq = COALESCE((SELECT MAX(change_seq) FROM messages), 0);

ALTER TABLE messages
  ALTER COLUMN message_seq SET NOT NULL,
  ALTER COLUMN change_seq  SET NOT NULL;

-- A change number is drawn once and belongs to exactly one change; a create
-- number belongs to exactly one message. Both catch an allocator fault at the
-- first bad write rather than at sync time.
ALTER TABLE messages
  ADD CONSTRAINT messages_message_seq_key UNIQUE (message_seq),
  ADD CONSTRAINT messages_change_seq_key  UNIQUE (change_seq);

-- One command identifier per sender yields at most one message.
CREATE UNIQUE INDEX messages_sender_command_id_key
  ON messages (sender_id, client_command_id)
  WHERE client_command_id IS NOT NULL;

CREATE FUNCTION messages_assign_create_seq() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.message_seq IS NULL THEN
    NEW.message_seq := next_message_seq();
  END IF;
  -- A create is itself the first change, so both numbers come from the same
  -- allocation: a single cursor over change_seq then sees creates and edits
  -- as one gapless stream.
  NEW.change_seq := NEW.message_seq;
  NEW.revision   := 1;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_messages_assign_create_seq
  BEFORE INSERT ON messages
  FOR EACH ROW EXECUTE FUNCTION messages_assign_create_seq();

CREATE FUNCTION messages_advance_change_seq() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  NEW.message_seq := OLD.message_seq;  -- creation order never moves
  NEW.change_seq  := next_message_seq();
  NEW.revision    := OLD.revision + 1;
  RETURN NEW;
END;
$$;

-- Restricted to the columns that are a Message Change. reply_to_id is set NULL
-- by a foreign key when a replied-to message is hard-deleted; that must not
-- burn a change number or push a no-op revision to synced clients.
CREATE TRIGGER trg_messages_advance_change_seq
  BEFORE UPDATE ON messages
  FOR EACH ROW
  WHEN (OLD.content IS DISTINCT FROM NEW.content
     OR OLD.is_recalled IS DISTINCT FROM NEW.is_recalled)
  EXECUTE FUNCTION messages_advance_change_seq();

ALTER TABLE room_members
  ADD COLUMN join_seq      BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN last_read_seq BIGINT NOT NULL DEFAULT 0;

UPDATE room_members rm
SET join_seq = COALESCE((
      SELECT MAX(m.message_seq)
      FROM messages m
      WHERE m.room_id = rm.room_id
        AND m.sent_at <= rm.join_time
    ), 0),
    last_read_seq = COALESCE((
      SELECT m.message_seq
      FROM messages m
      WHERE m.message_id = rm.last_read_id
    ), 0);

CREATE INDEX idx_messages_room_seq   ON messages (room_id, message_seq DESC);
CREATE INDEX idx_messages_change_seq ON messages (change_seq);
DROP INDEX IF EXISTS idx_messages_pagination;

-- Column list changes, so the view has to be dropped rather than replaced.
DROP VIEW IF EXISTS room_last_message_view;
CREATE VIEW room_last_message_view AS
SELECT DISTINCT ON (m.room_id)
  m.room_id,
  m.message_id,
  m.sender_id,
  m.content,
  m.sent_at,
  m.message_seq
FROM messages m
ORDER BY m.room_id, m.message_seq DESC;

CREATE OR REPLACE VIEW message_with_sender_view AS
SELECT
  m.message_id,
  m.room_id,
  m.sender_id,
  m.content,
  m.reply_to_id,
  m.is_recalled,
  m.sent_at,
  u.user_id AS sender_user_id,
  u.name AS sender_name,
  u.avatar_url AS sender_avatar_url,
  u.deleted_at AS sender_deleted_at,
  -- Appended: CREATE OR REPLACE VIEW can only add columns at the end.
  m.message_seq,
  m.change_seq,
  m.revision,
  m.client_command_id
FROM messages m
LEFT JOIN users u ON u.user_id = m.sender_id;

--- Down migration

DROP VIEW IF EXISTS message_with_sender_view;
DROP VIEW IF EXISTS room_last_message_view;

CREATE VIEW message_with_sender_view AS
SELECT
  m.message_id,
  m.room_id,
  m.sender_id,
  m.content,
  m.reply_to_id,
  m.is_recalled,
  m.sent_at,
  u.user_id AS sender_user_id,
  u.name AS sender_name,
  u.avatar_url AS sender_avatar_url,
  u.deleted_at AS sender_deleted_at
FROM messages m
LEFT JOIN users u ON u.user_id = m.sender_id;

CREATE VIEW room_last_message_view AS
SELECT
  m.room_id,
  m.message_id,
  m.sender_id,
  m.content,
  m.sent_at
FROM messages m
WHERE NOT EXISTS (
  SELECT 1
  FROM messages newer
  WHERE newer.room_id = m.room_id
    AND (
      newer.sent_at > m.sent_at
      OR (newer.sent_at = m.sent_at AND newer.message_id > m.message_id)
    )
);

CREATE INDEX IF NOT EXISTS idx_messages_pagination ON messages (room_id, sent_at DESC, message_id DESC);
DROP INDEX IF EXISTS idx_messages_change_seq;
DROP INDEX IF EXISTS idx_messages_room_seq;

ALTER TABLE room_members
  DROP COLUMN IF EXISTS last_read_seq,
  DROP COLUMN IF EXISTS join_seq;

DROP TRIGGER IF EXISTS trg_messages_advance_change_seq ON messages;
DROP TRIGGER IF EXISTS trg_messages_assign_create_seq ON messages;
DROP FUNCTION IF EXISTS messages_advance_change_seq();
DROP FUNCTION IF EXISTS messages_assign_create_seq();

DROP INDEX IF EXISTS messages_sender_command_id_key;
ALTER TABLE messages
  DROP CONSTRAINT IF EXISTS messages_change_seq_key,
  DROP CONSTRAINT IF EXISTS messages_message_seq_key;

ALTER TABLE messages
  DROP COLUMN IF EXISTS client_command_id,
  DROP COLUMN IF EXISTS revision,
  DROP COLUMN IF EXISTS change_seq,
  DROP COLUMN IF EXISTS message_seq;

DROP FUNCTION IF EXISTS next_message_seq();
DROP TABLE IF EXISTS message_sequence_counter;
