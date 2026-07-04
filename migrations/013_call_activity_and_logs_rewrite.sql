-- 013: Rewire call tracking.
--   caller_activity  →  aggregate + block flag, keyed by (qr_id, from_number).
--                       Also stores to_number (latest destination this caller
--                       reached) and last_call_sid for retry/reconciliation.
--   call_logs        →  per-call record. One row per completed Exotel call,
--                       written by the /api/exotel/call-completion webhook.
--                       Adds qr_id, to_number, from_number, call_sid, and
--                       an optional geolocation triplet (copied from
--                       alert_events at webhook time).
--
-- caller_activity is TRUNCATEd because the column semantics change (rename
-- + new mutable fields). Approved as a dev-only reset.
--
-- Idempotent: the TRUNCATE + RENAME only fire once — subsequent runs of
-- `npm run migrate` are no-ops thanks to the "if caller_number still
-- exists" guard.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'caller_activity' AND column_name = 'caller_number'
  ) THEN
    TRUNCATE TABLE caller_activity RESTART IDENTITY;
    ALTER TABLE caller_activity RENAME COLUMN caller_number TO from_number;
  END IF;
END $$;

ALTER TABLE caller_activity
  ADD COLUMN IF NOT EXISTS to_number VARCHAR(30);
ALTER TABLE caller_activity
  ADD COLUMN IF NOT EXISTS last_call_sid VARCHAR(100);

-- Extend call_logs into a real per-call record. Existing rows written by
-- /alert/create-call keep NULL for the new columns — they're legacy audit
-- entries and won't show up in the mobile Call Logs tab because that
-- listing filters WHERE qr_id IS NOT NULL.
ALTER TABLE call_logs
  ADD COLUMN IF NOT EXISTS qr_id INTEGER REFERENCES qrdata(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS to_number VARCHAR(30),
  ADD COLUMN IF NOT EXISTS from_number VARCHAR(30),
  ADD COLUMN IF NOT EXISTS call_sid VARCHAR(100),
  ADD COLUMN IF NOT EXISTS latitude DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS longitude DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS accuracy_meters DOUBLE PRECISION;

CREATE INDEX IF NOT EXISTS idx_call_logs_qr_id_start_time
  ON call_logs(qr_id, start_time DESC);
CREATE INDEX IF NOT EXISTS idx_call_logs_call_sid
  ON call_logs(call_sid);
