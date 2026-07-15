-- Migration 021 — race-condition uniqueness guards.
--
-- Two TOCTOU windows closed here:
--
-- 1. qrdata.vehicle_number
--    createQrRecord() checks getQrByVehicleNumber() BEFORE its DB
--    transaction. Under concurrent submits (double-tap + slow network,
--    two devices with the same vehicle) both checks can pass and both
--    INSERTs succeed. Adding a UNIQUE index means the second INSERT
--    fails with 23505 which the service now catches and turns into a
--    clean 400 error.
--    Uses `DO $$ BEGIN ... EXCEPTION ... END $$` so the migration is
--    idempotent even if two duplicate rows already exist (in which
--    case the constraint add would otherwise fail).
--
-- 2. login_otp — one active OTP per mobile
--    issueLoginOtp() marks prior OTPs used and inserts a new one, but
--    two concurrent /auth/login calls can both slip through and leave
--    two unused rows for the same mobile. The verify path picks the
--    newest, so this is more a data-hygiene problem than a security
--    one — but a partial unique index closes it cleanly.

-- Explicit "does this already exist?" check because a previous partial
-- run of this migration may have left the constraint or its underlying
-- index behind. The DO-block previously caught only `duplicate_object`;
-- Postgres actually raises `duplicate_table` (42P07) when the backing
-- index already exists, which the old handler didn't cover.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'qrdata_vehicle_number_unique'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_class WHERE relname = 'qrdata_vehicle_number_unique'
  ) THEN
    BEGIN
      ALTER TABLE qrdata
        ADD CONSTRAINT qrdata_vehicle_number_unique UNIQUE (vehicle_number);
    EXCEPTION
      -- Belt-and-suspenders for pre-existing duplicate rows. If two
      -- vehicles with the same number already made it into qrdata (from
      -- a race that happened before this migration), the ADD CONSTRAINT
      -- itself fails with unique_violation. Log and continue so the
      -- rest of the migration set can still run — ops needs to clean
      -- the duplicates manually.
      WHEN unique_violation THEN
        RAISE NOTICE 'Skipping qrdata_vehicle_number_unique — existing duplicates in qrdata. Run SELECT vehicle_number, COUNT(*) FROM qrdata GROUP BY vehicle_number HAVING COUNT(*) > 1 to find them.';
    END;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS login_otp_active_per_mobile
  ON login_otp(mobile)
  WHERE used_at IS NULL;
