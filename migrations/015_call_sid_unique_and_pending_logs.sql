-- 015: Make call_logs.call_sid UNIQUE so we can INSERT ... ON CONFLICT
-- to implement the two-phase call log flow:
--   1. /exotel/lookup inserts a "pending" row (start_time only)
--   2. /api/exotel/call-completion UPDATEs by call_sid with duration + end_time
--
-- Fixes the attribution race where a caller making rapid successive calls
-- to different family contacts on the same QR could lose earlier calls'
-- qr_id when caller_activity.to_number was overwritten by later lookups.
--
-- If any duplicate call_sid rows exist from previous inserts, we keep only
-- the newest (highest id) per call_sid before adding the constraint.

DELETE FROM call_logs
 WHERE call_sid IS NOT NULL
   AND id NOT IN (
     SELECT MAX(id) FROM call_logs
      WHERE call_sid IS NOT NULL
      GROUP BY call_sid
   );

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'call_logs_call_sid_unique'
  ) THEN
    ALTER TABLE call_logs
      ADD CONSTRAINT call_logs_call_sid_unique UNIQUE (call_sid);
  END IF;
END $$;
