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

DO $$
BEGIN
  ALTER TABLE qrdata
    ADD CONSTRAINT qrdata_vehicle_number_unique UNIQUE (vehicle_number);
EXCEPTION
  WHEN duplicate_object THEN NULL;      -- constraint already exists
  WHEN unique_violation THEN
    RAISE NOTICE 'Skipping qrdata_vehicle_number_unique — existing duplicates. Clean them up manually.';
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS login_otp_active_per_mobile
  ON login_otp(mobile)
  WHERE used_at IS NULL;
