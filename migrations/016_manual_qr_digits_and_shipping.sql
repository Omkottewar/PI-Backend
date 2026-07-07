-- 016: Pre-allocate the 5-digit extension code on manual_qr at MINT time
--      (not at activation time) so physical stickers can be printed with
--      the extension already visible. Also add shipping address fields
--      to qrdata for physical fulfillment.
--
-- Both auto (paid via /qr/create) and manual (referral via
-- /alert/:uniqueId/manual_activate) QRs use auto-incrementing Postgres
-- SEQUENCEs for their digits:
--   Auto   → qrdata_digits_auto_seq   (10000..69999)
--   Manual → qrdata_digits_manual_seq (70000..999999)
-- After this migration, manual_qr also carries the pre-allocated digits
-- so the sticker can be printed at manufacturing time.

-- 1. Add pre-allocated digits to manual_qr.
-- If an earlier manual patch created the column under a different name
-- (`extension_number`), rename it in place instead of adding a second one.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'manual_qr' AND column_name = 'extension_number'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'manual_qr' AND column_name = 'digits'
  ) THEN
    ALTER TABLE manual_qr RENAME COLUMN extension_number TO digits;
  END IF;
END $$;

ALTER TABLE manual_qr
  ADD COLUMN IF NOT EXISTS digits VARCHAR(10);

-- Backfill any existing manual_qr rows without digits — assign from the
-- manual sequence. Idempotent: only rows with NULL are affected.
DO $$
DECLARE
  r RECORD;
  next_digit TEXT;
BEGIN
  FOR r IN SELECT id FROM manual_qr WHERE digits IS NULL LOOP
    next_digit := nextval('qrdata_digits_manual_seq')::text;
    UPDATE manual_qr SET digits = next_digit WHERE id = r.id;
  END LOOP;
END $$;

-- Only enforce NOT NULL after backfill so a re-run remains safe.
ALTER TABLE manual_qr
  ALTER COLUMN digits SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'manual_qr_digits_unique'
  ) THEN
    ALTER TABLE manual_qr
      ADD CONSTRAINT manual_qr_digits_unique UNIQUE (digits);
  END IF;
END $$;

-- 2. Add shipping address fields to qrdata. All nullable — legacy QRs
--    created before this migration won't have them.
ALTER TABLE qrdata
  ADD COLUMN IF NOT EXISTS shipping_address_line1 VARCHAR(255),
  ADD COLUMN IF NOT EXISTS shipping_address_line2 VARCHAR(255),
  ADD COLUMN IF NOT EXISTS shipping_city          VARCHAR(120),
  ADD COLUMN IF NOT EXISTS shipping_state         VARCHAR(120),
  ADD COLUMN IF NOT EXISTS shipping_pincode       VARCHAR(10),
  ADD COLUMN IF NOT EXISTS shipping_country       VARCHAR(60) DEFAULT 'India';
