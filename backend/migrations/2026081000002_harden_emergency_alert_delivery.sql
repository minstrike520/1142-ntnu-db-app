--- Up migration

-- Alert rows are delivery leases, not an irrevocable sent flag. A process
-- crash between reserving an incident and writing all recipient messages can
-- therefore be retried after the lease expires.
ALTER TABLE emergency_alert_logs
  ADD COLUMN IF NOT EXISTS delivery_status VARCHAR(16) NOT NULL DEFAULT 'completed',
  ADD COLUMN IF NOT EXISTS lease_until TIMESTAMPTZ;

ALTER TABLE emergency_alert_logs
  DROP CONSTRAINT IF EXISTS emergency_alert_logs_delivery_status;

ALTER TABLE emergency_alert_logs
  ADD CONSTRAINT emergency_alert_logs_delivery_status
  CHECK (delivery_status IN ('pending', 'completed'));

--- Down migration
ALTER TABLE emergency_alert_logs
  DROP CONSTRAINT IF EXISTS emergency_alert_logs_delivery_status,
  DROP COLUMN IF EXISTS lease_until,
  DROP COLUMN IF EXISTS delivery_status;
