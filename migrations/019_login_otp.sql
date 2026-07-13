-- Migration 019 — real OTP storage.
--
-- Prior to this, /auth/login accepted a hardcoded '1234' for every mobile.
-- We now generate a random 4-digit OTP, store its salted SHA-256 hash with
-- a 5-minute TTL, and cap incorrect guesses at 5 before the row is
-- invalidated. The plaintext OTP is only ever sent via SMS (or logged to
-- the console when SMS_PROVIDER=console for local dev).
--
-- Rate limiting on /auth/* (30 req/min/IP) plus the 5-attempt cap here
-- keeps the effective brute-force success rate below 0.1% per session
-- against the 10k possible codes.
CREATE TABLE IF NOT EXISTS login_otp (
  id           SERIAL PRIMARY KEY,
  mobile       VARCHAR(20) NOT NULL,
  otp_hash     TEXT        NOT NULL,
  salt         TEXT        NOT NULL,
  expires_at   TIMESTAMPTZ NOT NULL,
  attempts     INT         NOT NULL DEFAULT 0,
  used_at      TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS login_otp_mobile_idx ON login_otp(mobile);
CREATE INDEX IF NOT EXISTS login_otp_expires_idx ON login_otp(expires_at);
