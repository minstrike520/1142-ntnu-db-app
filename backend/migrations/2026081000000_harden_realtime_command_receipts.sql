--- Up migration

-- This is a follow-up migration because the realtime durability migration may
-- already have been applied in deployed environments. Keep upgrades additive.
ALTER TABLE read_position_commands
  ADD COLUMN IF NOT EXISTS message_id UUID REFERENCES messages(message_id) ON DELETE CASCADE;

-- Ensure newly allocated sequences cannot collide with rows written before the
-- realtime counter was introduced or after a partially applied upgrade.
UPDATE realtime_counters
SET message_sequence = GREATEST(
      message_sequence,
      COALESCE((SELECT MAX(message_sequence) FROM messages), 0)
    ),
    change_sequence = GREATEST(
      change_sequence,
      COALESCE((SELECT MAX(change_sequence) FROM message_changes), 0)
    )
WHERE counter_id = true;

--- Down migration
ALTER TABLE read_position_commands
  DROP COLUMN IF EXISTS message_id;
