-- Up Migration
-- Per-contact delivery receipts for emergency alerts.
--
-- `emergency_alert_logs` tracks an incident as a whole: one lease per
-- `(user_id, last_activity_at)`. That is the right granularity for retrying,
-- but the wrong one for deciding who still needs telling. When one contact
-- fails, the incident lease is released and the next run re-delivers to *every*
-- contact, so anyone already alerted hears about the same incident again on
-- each pass until the failing contact recovers.
--
-- The message itself is idempotent (its command key is per contact and per
-- incident), but `emergency_alert` is a transient socket event with no such
-- key and no recovery path. It needs its own record, at contact granularity.
CREATE TABLE IF NOT EXISTS emergency_alert_deliveries (
  user_id      UUID         NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  contact_id   UUID         NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  -- The incident's `last_activity_at`, in ISO form, as the notify path already
  -- passes it. Stored as text so it round-trips exactly as the caller sent it.
  incident_id  VARCHAR(64)  NOT NULL,
  delivered_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, contact_id, incident_id)
);

-- Down Migration
DROP TABLE IF EXISTS emergency_alert_deliveries;
