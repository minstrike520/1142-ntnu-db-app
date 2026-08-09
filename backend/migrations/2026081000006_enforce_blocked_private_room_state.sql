-- Keep the durable room state safe even when block/create-private requests
-- race across backend processes. The trigger runs in the same transaction as
-- the block or membership insert, so a concurrent reopen can only commit
-- before the block (and is then made read-only) or fail its conditional update.

CREATE OR REPLACE FUNCTION mark_blocked_private_rooms_readonly()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE chat_rooms cr
  SET is_readonly = true
  WHERE cr.type = 'private'
    AND EXISTS (
      SELECT 1
      FROM room_members rm_a
      JOIN room_members rm_b ON rm_b.room_id = rm_a.room_id
      WHERE rm_a.room_id = cr.room_id
        AND rm_a.user_id = NEW.blocker_id
        AND rm_b.user_id = NEW.blocked_id
    );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS blocks_mark_private_rooms_readonly ON blocks;
CREATE TRIGGER blocks_mark_private_rooms_readonly
AFTER INSERT ON blocks
FOR EACH ROW
EXECUTE FUNCTION mark_blocked_private_rooms_readonly();

CREATE OR REPLACE FUNCTION mark_new_private_membership_readonly()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE chat_rooms cr
  SET is_readonly = true
  WHERE cr.room_id = NEW.room_id
    AND cr.type = 'private'
    AND EXISTS (
      SELECT 1
      FROM room_members other
      JOIN blocks b ON (
        (b.blocker_id = NEW.user_id AND b.blocked_id = other.user_id)
        OR (b.blocker_id = other.user_id AND b.blocked_id = NEW.user_id)
      )
      WHERE other.room_id = NEW.room_id
        AND other.user_id <> NEW.user_id
    );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS room_members_mark_blocked_private_rooms_readonly ON room_members;
CREATE TRIGGER room_members_mark_blocked_private_rooms_readonly
AFTER INSERT ON room_members
FOR EACH ROW
EXECUTE FUNCTION mark_new_private_membership_readonly();

-- Down migration
DROP TRIGGER IF EXISTS room_members_mark_blocked_private_rooms_readonly ON room_members;
DROP TRIGGER IF EXISTS blocks_mark_private_rooms_readonly ON blocks;
DROP FUNCTION IF EXISTS mark_new_private_membership_readonly();
DROP FUNCTION IF EXISTS mark_blocked_private_rooms_readonly();
