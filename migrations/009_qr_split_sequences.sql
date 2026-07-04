-- 009: Split QR short-code allocation into two ranges.
--   Auto (purchased)  : 10000..69999  (sequence: qrdata_digits_auto_seq)
--   Manual (referral) : 70000..999999 (sequence: qrdata_digits_manual_seq)
-- Adds is_manual flag on qrdata.
--
-- NOTE: This migration used to TRUNCATE qrdata during initial dev to reset
-- the sequence namespace. The TRUNCATE has been removed now that the app
-- carries real data — it was wiping every QR every time `npm run migrate`
-- was invoked, because there is no migration-tracking table and all
-- .sql files re-run on every migrate.

-- 1. Add is_manual flag.
ALTER TABLE qrdata
  ADD COLUMN IF NOT EXISTS is_manual BOOLEAN NOT NULL DEFAULT false;

-- 2. Widen digits column so 5+ digit codes fit. CHAR(4) would truncate.
ALTER TABLE qrdata DROP CONSTRAINT IF EXISTS qrdata_digits_unique;
ALTER TABLE qrdata ALTER COLUMN digits DROP NOT NULL;
ALTER TABLE qrdata ALTER COLUMN digits TYPE VARCHAR(10);
ALTER TABLE qrdata ALTER COLUMN digits SET NOT NULL;
ALTER TABLE qrdata ADD CONSTRAINT qrdata_digits_unique UNIQUE (digits);

-- 3. Drop the old shared sequence; create two range-scoped sequences.
DROP SEQUENCE IF EXISTS qrdata_digits_seq;

CREATE SEQUENCE IF NOT EXISTS qrdata_digits_auto_seq
  AS INTEGER
  MINVALUE 10000
  MAXVALUE 69999
  START WITH 10000;

CREATE SEQUENCE IF NOT EXISTS qrdata_digits_manual_seq
  AS BIGINT
  MINVALUE 70000
  MAXVALUE 999999
  START WITH 70000;

-- Re-assert bounds in case sequences already existed from a prior run.
ALTER SEQUENCE qrdata_digits_auto_seq   MINVALUE 10000 MAXVALUE 69999;
ALTER SEQUENCE qrdata_digits_manual_seq MINVALUE 70000 MAXVALUE 999999;
