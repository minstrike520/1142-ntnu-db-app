--- Up migration

-- Add the durable ordering, recovery, and idempotency primitives used by the
-- REST command surface. The timestamp is after every migration already
-- released, so existing databases can upgrade without migration reordering.

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS message_sequence BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS change_sequence BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS command_id VARCHAR(255);

ALTER TABLE messages
  DROP CONSTRAINT IF EXISTS messages_revision_positive;

ALTER TABLE messages
  ADD CONSTRAINT messages_revision_positive CHECK (revision > 0);

CREATE TABLE IF NOT EXISTS realtime_counters (
  counter_id       BOOLEAN PRIMARY KEY DEFAULT true CHECK (counter_id = true),
  message_sequence BIGINT NOT NULL DEFAULT 0,
  change_sequence  BIGINT NOT NULL DEFAULT 0
);

INSERT INTO realtime_counters (counter_id)
VALUES (true)
ON CONFLICT (counter_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS message_changes (
  change_sequence  BIGINT       PRIMARY KEY,
  message_id       UUID         NOT NULL REFERENCES messages(message_id) ON DELETE CASCADE,
  room_id          UUID         NOT NULL REFERENCES chat_rooms(room_id) ON DELETE CASCADE,
  message_sequence BIGINT       NOT NULL,
  revision         INTEGER      NOT NULL CHECK (revision > 0),
  change_type      VARCHAR(16)  NOT NULL CHECK (change_type IN ('created', 'edited', 'recalled')),
  actor_id         UUID         REFERENCES users(user_id) ON DELETE SET NULL,
  command_id       VARCHAR(255),
  sender_id        UUID         REFERENCES users(user_id) ON DELETE SET NULL,
  content          TEXT         NOT NULL,
  is_recalled      BOOLEAN      NOT NULL,
  reply_to_id      UUID         REFERENCES messages(message_id) ON DELETE SET NULL,
  sent_at          TIMESTAMPTZ  NOT NULL,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS messages_sender_command_id_idx
  ON messages (sender_id, command_id)
  WHERE command_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS message_changes_room_sequence_idx
  ON message_changes (room_id, change_sequence);

CREATE UNIQUE INDEX IF NOT EXISTS message_changes_actor_command_id_idx
  ON message_changes (actor_id, command_id)
  WHERE command_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS read_position_commands (
  user_id          UUID         NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  command_id       VARCHAR(255) NOT NULL,
  room_id          UUID         NOT NULL REFERENCES chat_rooms(room_id) ON DELETE CASCADE,
  read_position    BIGINT       NOT NULL,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, command_id)
);

ALTER TABLE room_members
  ADD COLUMN IF NOT EXISTS join_boundary BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS read_position BIGINT NOT NULL DEFAULT 0;

-- Recreate the views after adding their sequence fields. This also upgrades an
-- existing database whose earlier view migration has already run.
DROP VIEW IF EXISTS room_last_message_view;
DROP VIEW IF EXISTS message_with_sender_view;

CREATE OR REPLACE VIEW message_with_sender_view AS
SELECT
  m.message_id,
  m.room_id,
  m.sender_id,
  m.content,
  m.reply_to_id,
  m.is_recalled,
  m.sent_at,
  m.message_sequence,
  m.change_sequence,
  m.revision,
  u.user_id AS sender_user_id,
  u.name AS sender_name,
  u.avatar_url AS sender_avatar_url,
  u.deleted_at AS sender_deleted_at
FROM messages m
LEFT JOIN users u ON u.user_id = m.sender_id;

CREATE OR REPLACE VIEW room_last_message_view AS
SELECT
  m.room_id,
  m.message_id,
  m.sender_id,
  m.content,
  m.sent_at,
  m.message_sequence,
  m.change_sequence,
  m.revision
FROM messages m
WHERE NOT EXISTS (
  SELECT 1
  FROM messages newer
  WHERE newer.room_id = m.room_id
    AND (
      newer.message_sequence > m.message_sequence
      OR (
        newer.message_sequence = m.message_sequence
        AND (
          (m.message_sequence = 0 AND newer.sent_at > m.sent_at)
          OR (newer.sent_at = m.sent_at AND newer.message_id > m.message_id)
        )
      )
    )
);

--- Down migration
DROP VIEW IF EXISTS room_last_message_view;
DROP VIEW IF EXISTS message_with_sender_view;
ALTER TABLE room_members
  DROP COLUMN IF EXISTS read_position,
  DROP COLUMN IF EXISTS join_boundary;
DROP TABLE IF EXISTS read_position_commands;
DROP TABLE IF EXISTS message_changes;
DROP TABLE IF EXISTS realtime_counters;
DROP INDEX IF EXISTS messages_sender_command_id_idx;
ALTER TABLE messages
  DROP CONSTRAINT IF EXISTS messages_revision_positive,
  DROP COLUMN IF EXISTS command_id,
  DROP COLUMN IF EXISTS revision,
  DROP COLUMN IF EXISTS change_sequence,
  DROP COLUMN IF EXISTS message_sequence;
