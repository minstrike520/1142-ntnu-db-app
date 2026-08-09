--- Up migration

-- A change row must describe the message version that it represents. Existing
-- rows cannot be reconstructed after mentions/attachments have been edited, so
-- they receive an honest empty snapshot; all new changes capture relations in
-- the same transaction as the message mutation.
ALTER TABLE message_changes
  ADD COLUMN IF NOT EXISTS mentions JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS attachments JSONB NOT NULL DEFAULT '[]'::jsonb;

-- The current message projection is safe to backfill only when it is the
-- exact change row that produced that projection. Older revisions remain the
-- honest empty snapshot described above rather than being rewritten with
-- today's relations.
UPDATE message_changes mc
SET mentions = COALESCE((
      SELECT jsonb_agg(mm.user_id ORDER BY mm.user_id)
      FROM message_mentions mm
      WHERE mm.message_id = mc.message_id
    ), '[]'::jsonb),
    attachments = COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'attachment_id', a.attachment_id,
        'message_id', a.message_id,
        'uploaded_by', a.uploaded_by,
        'file_type', a.file_type,
        'original_name', a.original_name,
        'uploaded_at', a.uploaded_at
      ) ORDER BY a.uploaded_at, a.attachment_id)
      FROM attachments a
      WHERE a.message_id = mc.message_id
    ), '[]'::jsonb)
FROM messages m
WHERE m.message_id = mc.message_id
  AND mc.change_sequence = m.change_sequence
  AND mc.revision = m.revision;

--- Down migration
ALTER TABLE message_changes
  DROP COLUMN IF EXISTS attachments,
  DROP COLUMN IF EXISTS mentions;
