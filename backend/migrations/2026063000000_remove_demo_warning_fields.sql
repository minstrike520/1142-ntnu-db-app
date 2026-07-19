--- Up migration
ALTER TABLE users
  DROP COLUMN IF EXISTS demo_warning_enabled,
  DROP COLUMN IF EXISTS demo_warning_seconds;

--- Down migration
ALTER TABLE users
  ADD COLUMN demo_warning_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN demo_warning_seconds INTEGER NOT NULL DEFAULT 30;
