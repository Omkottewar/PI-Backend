-- 014: Drop dead tables and redundant columns identified in the pre-launch
-- schema audit.
--
-- alert_logs:    declared in migration 001, never referenced by any code.
-- callHistory:   superseded by call_logs. The /api/call-history route is
--                being removed alongside this file; mobile has been on
--                /profile/call-logs since migration 013 landed.
-- qrdata.credits: declared with default 50 in migration 002, never read.
-- call_logs.call_uuid / caller_number / receiver_number:
--                superseded by call_sid / from_number / to_number in
--                migration 013.
--
-- Everything else in the schema is actively used and stays as-is.
-- Migration is idempotent (IF EXISTS throughout).

DROP TABLE IF EXISTS alert_logs;
DROP TABLE IF EXISTS "callHistory";

ALTER TABLE qrdata    DROP COLUMN IF EXISTS credits;
ALTER TABLE call_logs DROP COLUMN IF EXISTS call_uuid;
ALTER TABLE call_logs DROP COLUMN IF EXISTS caller_number;
ALTER TABLE call_logs DROP COLUMN IF EXISTS receiver_number;
