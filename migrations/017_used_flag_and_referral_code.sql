-- 017: Two related additions.
--
-- 1. manual_qr.used — marks a sticker as "redeemed by a customer" (as opposed
--    to "deactivated by admin"). is_active stays for the admin-side controls;
--    used is set true when /alert/:uniqueId/manual_activate succeeds.
--
-- 2. qrdata.referral_code — copied from manual_qr on manual activation so
--    campaigns can be queried directly on qrdata without a JOIN. NULL for
--    paid QRs.

ALTER TABLE manual_qr
  ADD COLUMN IF NOT EXISTS used BOOLEAN NOT NULL DEFAULT false;

-- Backfill: any manual_qr row that is inactive AND has a corresponding
-- qrdata row (meaning it was redeemed) gets used = true.
UPDATE manual_qr mq
   SET used = true
  WHERE mq.is_active = false
    AND EXISTS (
      SELECT 1 FROM qrdata q WHERE q.unique_id = mq.qr_unique_id
    );

ALTER TABLE qrdata
  ADD COLUMN IF NOT EXISTS referral_code VARCHAR(50);

-- Backfill referral_code on existing manual QRs.
UPDATE qrdata q
   SET referral_code = mq.referral_code
  FROM manual_qr mq
 WHERE q.unique_id = mq.qr_unique_id
   AND q.referral_code IS NULL
   AND q.is_manual = true;
