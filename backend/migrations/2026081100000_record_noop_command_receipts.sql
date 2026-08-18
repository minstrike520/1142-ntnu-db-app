-- Up Migration
-- Close the one hole in the durable-command idempotency namespace.
--
-- `message_changes` doubles as the command receipt store: create, edit and
-- recall all record `(actor_id, command_id)` there, and each of them rejects a
-- key that already belongs to a different message or a different operation.
-- That only works for commands that commit a change. Recalling an
-- already-recalled message is a legitimate no-op — it must not allocate a
-- change sequence or publish a second `message_recalled` — so it left no
-- receipt at all, and the key stayed free to be reused for a message creation
-- or an edit afterwards.
--
-- Receipts for those no-ops go here instead. The table is only ever read
-- alongside `message_changes`, never on its own, so the namespace stays single
-- even though it is stored in two places.

CREATE TABLE IF NOT EXISTS message_command_receipts (
  actor_id        UUID         NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  command_id      VARCHAR(255) NOT NULL,
  message_id      UUID         NOT NULL REFERENCES messages(message_id) ON DELETE CASCADE,
  change_type     VARCHAR(16)  NOT NULL CHECK (change_type IN ('created', 'edited', 'recalled')),
  -- The change the command converged on, so a retry can answer with the same
  -- canonical projection. Nullable on purpose: a message recalled before the
  -- durability migration has no `recalled` row in `message_changes` to point
  -- at, and the retry then falls back to the current message state.
  change_sequence BIGINT,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (actor_id, command_id)
);

-- Down Migration
DROP TABLE IF EXISTS message_command_receipts;
