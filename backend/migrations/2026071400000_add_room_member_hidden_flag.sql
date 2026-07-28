--- Up migration
ALTER TABLE room_members
  ADD COLUMN is_hidden BOOLEAN NOT NULL DEFAULT false;

--- Down migration
ALTER TABLE room_members
  DROP COLUMN is_hidden;
