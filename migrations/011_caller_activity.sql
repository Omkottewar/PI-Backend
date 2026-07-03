-- 011: Track how many times each phone number has called a given QR through
-- the Exotel bridge. Lets the owner see suspicious activity and manually
-- block spammers. Blocks are per-(QR, caller) and permanent until unblocked.

CREATE TABLE IF NOT EXISTS caller_activity (
  id SERIAL PRIMARY KEY,
  qr_id INTEGER NOT NULL REFERENCES qrdata(id) ON DELETE CASCADE,
  caller_number VARCHAR(30) NOT NULL,
  call_count INTEGER NOT NULL DEFAULT 0,
  first_call_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_call_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  is_blocked BOOLEAN NOT NULL DEFAULT false,
  blocked_at TIMESTAMPTZ,
  UNIQUE (qr_id, caller_number)
);

CREATE INDEX IF NOT EXISTS idx_caller_activity_qr
  ON caller_activity(qr_id);

-- Partial index so listing blocked callers per QR is cheap (used by the
-- Exotel lookup fast-path).
CREATE INDEX IF NOT EXISTS idx_caller_activity_blocked
  ON caller_activity(qr_id, caller_number)
  WHERE is_blocked = true;
