--- Up migration

CREATE SEQUENCE realtime_revision_seq AS BIGINT;

ALTER TABLE messages
  ADD COLUMN revision BIGINT;

-- PostgreSQL does not guarantee that a volatile function in a SELECT list is
-- evaluated after that same SELECT's ORDER BY, so the sort is materialised in an
-- inner subquery and nextval() is applied over the already-ordered rows. This
-- keeps the backfilled revisions in chronological order.
UPDATE messages AS m
SET revision = ordered.revision
FROM (
  SELECT message_id, nextval('realtime_revision_seq') AS revision
  FROM (
    SELECT message_id
    FROM messages
    WHERE revision IS NULL
    ORDER BY sent_at, message_id
  ) AS chronological
) AS ordered
WHERE m.message_id = ordered.message_id;

ALTER TABLE messages
  ALTER COLUMN revision SET DEFAULT nextval('realtime_revision_seq'),
  ALTER COLUMN revision SET NOT NULL;

CREATE UNIQUE INDEX messages_revision_key ON messages (revision);

DROP VIEW message_with_sender_view;
CREATE VIEW message_with_sender_view AS
SELECT
  m.message_id,
  m.room_id,
  m.sender_id,
  m.content,
  m.reply_to_id,
  m.is_recalled,
  m.sent_at,
  m.revision,
  u.user_id AS sender_user_id,
  u.name AS sender_name,
  u.avatar_url AS sender_avatar_url,
  u.deleted_at AS sender_deleted_at
FROM messages m
LEFT JOIN users u ON u.user_id = m.sender_id;

CREATE TABLE message_changes (
  revision    BIGINT PRIMARY KEY DEFAULT nextval('realtime_revision_seq'),
  message_id  UUID NOT NULL REFERENCES messages(message_id) ON DELETE CASCADE,
  room_id     UUID NOT NULL REFERENCES chat_rooms(room_id) ON DELETE CASCADE,
  change_type VARCHAR(10) NOT NULL CHECK (change_type IN ('created', 'updated', 'recalled')),
  sender_id   UUID REFERENCES users(user_id) ON DELETE SET NULL,
  content     TEXT NOT NULL,
  reply_to_id UUID REFERENCES messages(message_id) ON DELETE SET NULL,
  is_recalled BOOLEAN NOT NULL,
  sent_at     TIMESTAMPTZ NOT NULL,
  changed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO message_changes (
  revision, message_id, room_id, change_type, sender_id, content, reply_to_id, is_recalled, sent_at, changed_at
)
SELECT
  revision,
  message_id,
  room_id,
  CASE WHEN is_recalled THEN 'recalled' ELSE 'created' END,
  sender_id,
  content,
  reply_to_id,
  is_recalled,
  sent_at,
  sent_at
FROM messages;

SELECT setval(
  'realtime_revision_seq',
  GREATEST((SELECT COALESCE(MAX(revision), 0) FROM messages), 1),
  true
);

CREATE INDEX message_changes_room_revision_idx ON message_changes (room_id, revision);
CREATE INDEX message_changes_message_revision_idx ON message_changes (message_id, revision DESC);

CREATE TABLE message_commands (
  user_id      UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  command_id   VARCHAR(128) NOT NULL,
  command_type VARCHAR(20) NOT NULL CHECK (command_type IN ('message.send', 'message.edit', 'message.recall')),
  payload_hash CHAR(64) NOT NULL,
  message_id   UUID REFERENCES messages(message_id) ON DELETE CASCADE,
  result_revision BIGINT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, command_id)
);

ALTER TABLE room_members
  ADD COLUMN membership_epoch UUID NOT NULL DEFAULT gen_random_uuid();

CREATE OR REPLACE FUNCTION rotate_room_membership_epoch()
RETURNS TRIGGER AS $$
BEGIN
  IF (OLD.role = 'pending') IS DISTINCT FROM (NEW.role = 'pending') THEN
    NEW.membership_epoch = gen_random_uuid();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER room_membership_epoch_on_access_change
BEFORE UPDATE OF role ON room_members
FOR EACH ROW EXECUTE FUNCTION rotate_room_membership_epoch();

CREATE TABLE emergency_notifications (
  notification_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_user_id   UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  recipient_id     UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  idempotency_key  VARCHAR(255) NOT NULL,
  message          TEXT NOT NULL,
  delivery_state   VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (delivery_state IN ('pending', 'published')),
  acknowledged_at  TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  published_at     TIMESTAMPTZ,
  UNIQUE (recipient_id, idempotency_key)
);

CREATE INDEX emergency_notifications_recipient_created_idx
  ON emergency_notifications (recipient_id, acknowledged_at, created_at DESC);

ALTER TABLE emergency_alert_logs
  ADD COLUMN delivery_state VARCHAR(20) NOT NULL DEFAULT 'completed'
    CHECK (delivery_state IN ('pending', 'completed'));

ALTER TABLE emergency_alert_logs
  ALTER COLUMN delivery_state SET DEFAULT 'pending';

--- Down migration

DROP INDEX IF EXISTS emergency_notifications_recipient_created_idx;
DROP TABLE IF EXISTS emergency_notifications;
ALTER TABLE emergency_alert_logs DROP COLUMN IF EXISTS delivery_state;
DROP TRIGGER IF EXISTS room_membership_epoch_on_access_change ON room_members;
DROP FUNCTION IF EXISTS rotate_room_membership_epoch();
ALTER TABLE room_members DROP COLUMN IF EXISTS membership_epoch;
DROP TABLE IF EXISTS message_commands;
DROP INDEX IF EXISTS message_changes_message_revision_idx;
DROP INDEX IF EXISTS message_changes_room_revision_idx;
DROP TABLE IF EXISTS message_changes;
DROP INDEX IF EXISTS messages_revision_key;
DROP VIEW IF EXISTS message_with_sender_view;
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
ALTER TABLE messages DROP COLUMN IF EXISTS revision;
DROP SEQUENCE IF EXISTS realtime_revision_seq;
