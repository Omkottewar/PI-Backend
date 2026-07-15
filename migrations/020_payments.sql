-- Migration 020 — payments audit table.
--
-- Prior to this, signature verification happened inline in /qr/create and
-- /qr/:id/renew/verify and nothing about the payment was persisted. If
-- Razorpay charged the customer but the qrdata INSERT failed on our end,
-- the customer had no receipt trail on our side and we couldn't refund
-- or reconcile.
--
-- This table records every Razorpay order we create, links it to the
-- user + (once known) the qrdata row, tracks status transitions, and
-- carries both the amount Razorpay actually charged and the "intended"
-- (advertised) price — so the test-charge override can be reconciled.
--
-- Status lifecycle:
--   'created'  — order created via /orders API, checkout not yet completed
--   'verified' — HMAC signature valid, payment succeeded
--   'failed'   — signature mismatch OR Razorpay checkout failure
--
-- The service that writes this table calls CREATE TABLE IF NOT EXISTS on
-- first use (same self-heal pattern as login_otp) so a fresh Render pod
-- that hasn't run `npm run migrate` still works.
CREATE TABLE IF NOT EXISTS payments (
  id                    SERIAL PRIMARY KEY,
  user_id               INT REFERENCES users(id) ON DELETE SET NULL,
  qr_id                 INT REFERENCES qrdata(id) ON DELETE SET NULL,
  purpose               VARCHAR(20) NOT NULL,   -- 'qr_create' | 'qr_renew'
  razorpay_order_id     VARCHAR(64) NOT NULL,
  razorpay_payment_id   VARCHAR(64),
  razorpay_signature    TEXT,
  amount_paise          INT NOT NULL,           -- what Razorpay charged
  intended_amount_paise INT NOT NULL,           -- what the UI displayed
  currency              VARCHAR(8) NOT NULL DEFAULT 'INR',
  status                VARCHAR(20) NOT NULL DEFAULT 'created',
  error_message         TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  verified_at           TIMESTAMPTZ,
  UNIQUE (razorpay_order_id)
);

CREATE INDEX IF NOT EXISTS payments_user_idx    ON payments(user_id);
CREATE INDEX IF NOT EXISTS payments_qr_idx      ON payments(qr_id);
CREATE INDEX IF NOT EXISTS payments_status_idx  ON payments(status);
CREATE INDEX IF NOT EXISTS payments_created_idx ON payments(created_at DESC);
