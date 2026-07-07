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
-- Exotel lookup fast-path). The caller column was renamed from
-- `caller_number` to `from_number` in migration 013 — this DO block
-- picks whichever name is present so the migration is idempotent across
-- both fresh installs (caller_number) and re-runs after 013 has applied
-- (from_number). PostgreSQL preserves the index automatically when the
-- underlying column is renamed, so this only ever creates it once.
DO $$
DECLARE
  col_name TEXT;
BEGIN
  SELECT column_name INTO col_name
    FROM information_schema.columns
   WHERE table_name = 'caller_activity'
     AND column_name IN ('caller_number', 'from_number')
   LIMIT 1;

  IF col_name IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'public'
       AND indexname = 'idx_caller_activity_blocked'
  ) THEN
    EXECUTE format(
      'CREATE INDEX idx_caller_activity_blocked ON caller_activity(qr_id, %I) WHERE is_blocked = true',
      col_name
    );
  END IF;
END $$;
