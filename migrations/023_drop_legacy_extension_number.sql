-- Migration 023 — remove the legacy `extension_number` artifact from
-- manual_qr.
--
-- Background: an earlier schema had `manual_qr.extension_number` with a
-- UNIQUE constraint autonamed `manual_qr_extension_number_key`.
-- Migration 016 attempted to rename that column to `digits`, but Postgres
-- does NOT rename constraints when a column is renamed — so on any DB
-- that took the rename path the old constraint kept enforcing uniqueness
-- on the *renamed* column, in parallel with `manual_qr_digits_unique`
-- added later in migration 016.
--
-- On DBs where the column was hand-added separately (both columns exist
-- side-by-side), extension_number's own default or a rogue sequence
-- causes collisions on mint even though the mint code only touches
-- `digits`.
--
-- Fix: drop the legacy constraint unconditionally, and drop the leftover
-- column if it still exists as a distinct column from `digits`. Safe
-- because `manual_qr_digits_unique` (from migration 016) already
-- guarantees uniqueness on the digits column.
--
-- Fully idempotent — running twice is a no-op.

-- 1. Drop the legacy unique constraint if it's still around. Guarded so
--    this migration doesn't fail on DBs that never had it.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'manual_qr_extension_number_key'
  ) THEN
    ALTER TABLE manual_qr DROP CONSTRAINT manual_qr_extension_number_key;
    RAISE NOTICE 'Dropped legacy constraint manual_qr_extension_number_key';
  END IF;
END $$;

-- 2. Drop the leftover column if it exists alongside `digits`. If only
--    `extension_number` existed (never renamed) migration 016 would have
--    caught it — but this guard covers any weirder mid-state where both
--    columns co-exist. If `digits` doesn't exist yet, we do NOT drop
--    extension_number (would lose data) — that state means migration 016
--    hasn't run at all, which is a bigger problem to surface.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'manual_qr' AND column_name = 'extension_number'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'manual_qr' AND column_name = 'digits'
  ) THEN
    ALTER TABLE manual_qr DROP COLUMN extension_number;
    RAISE NOTICE 'Dropped leftover column manual_qr.extension_number';
  END IF;
END $$;

-- 3. Drop any orphan sequence that was backing extension_number's
--    default. Guarded — most DBs won't have it. Common autonamed
--    variants included so we don't miss it.
DO $$
DECLARE
  seq_name TEXT;
BEGIN
  FOR seq_name IN
    SELECT c.relname
      FROM pg_class c
     WHERE c.relkind = 'S'
       AND c.relname IN (
         'manual_qr_extension_number_seq',
         'extension_number_seq'
       )
  LOOP
    EXECUTE format('DROP SEQUENCE IF EXISTS %I', seq_name);
    RAISE NOTICE 'Dropped orphan sequence %', seq_name;
  END LOOP;
END $$;

-- 4. Definitive sequence resync — this is the mint-blocker fix.
--
-- Migration 022 tries to do this but uses `digits ~ '^[0-9]+$'` which
-- assumes a text-typed column. On DBs where digits was retyped to
-- INTEGER (as ours was), the regex throws `operator does not exist:
-- integer ~ unknown`, the exception handler leaves `max_manual` NULL,
-- the guard `max_manual >= 70000` evaluates to unknown → falsy, and the
-- setval never runs. Same trap in the pre-mint setval in admin.routes.js.
-- Result: sequence drifts behind actual max(digits), next nextval()
-- returns an already-used value, INSERT hits the UNIQUE constraint.
--
-- Fix: explicit `digits::text` cast so the query works whether digits
-- is stored as VARCHAR or INTEGER. Idempotent — never rewinds the
-- sequence below its current value.
DO $$
DECLARE
  max_digits INT;
  current_pos INT;
BEGIN
  SELECT COALESCE(MAX(d), 0) INTO max_digits FROM (
    SELECT CAST(digits::text AS INT) AS d
      FROM manual_qr
     WHERE digits::text ~ '^[0-9]+$'
    UNION ALL
    SELECT CAST(digits::text AS INT) AS d
      FROM qrdata
     WHERE is_manual = true AND digits::text ~ '^[0-9]+$'
  ) x;

  -- Only advance forward. Read the sequence's current position via
  -- pg_sequences (available since PG 10) — safer than currval() which
  -- throws when nextval() hasn't been called in this session.
  SELECT last_value INTO current_pos
    FROM pg_sequences
   WHERE schemaname = 'public' AND sequencename = 'qrdata_digits_manual_seq';

  IF max_digits > COALESCE(current_pos, 0) THEN
    PERFORM setval('qrdata_digits_manual_seq', max_digits, true);
    RAISE NOTICE 'qrdata_digits_manual_seq advanced to % (was %)',
                 max_digits, COALESCE(current_pos, 0);
  ELSE
    RAISE NOTICE 'qrdata_digits_manual_seq already ahead (% >= %)',
                 COALESCE(current_pos, 0), max_digits;
  END IF;
END $$;
