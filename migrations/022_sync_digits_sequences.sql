-- Migration 022 — resync digits sequences to actual table max.
--
-- Symptom: admin panel Mint endpoint returns
--   "Rare UUID or digits sequence collision. Retry the mint..."
-- Cause: qrdata_digits_manual_seq (and _auto_seq) drift behind the actual
-- max(digits) in manual_qr and qrdata. Postgres sequences don't
-- automatically catch up when data is loaded outside of nextval() —
-- e.g., a Supabase restore, a partial-batch mint that rolled back but
-- consumed sequence values, or a manual seed.
--
-- Fix: advance each sequence past the highest digits value that
-- currently exists. Uses setval() with `false` third arg so the NEXT
-- nextval() returns exactly (max + 1) — no wasted values.
--
-- Idempotent — running this twice is a no-op if the sequence is
-- already ahead.
DO $$
DECLARE
  max_manual  INT;
  max_auto    INT;
BEGIN
  -- Pull the highest digits across BOTH tables that use each sequence.
  -- manual_qr and qrdata (is_manual=true) share the manual sequence;
  -- qrdata (is_manual=false) uses the auto sequence.
  SELECT COALESCE(MAX(d), 0) INTO max_manual FROM (
    SELECT CAST(digits AS INT) AS d FROM manual_qr WHERE digits ~ '^[0-9]+$'
    UNION ALL
    SELECT CAST(digits AS INT) AS d FROM qrdata
     WHERE is_manual = true AND digits ~ '^[0-9]+$'
  ) x;
  SELECT COALESCE(MAX(CAST(digits AS INT)), 0) INTO max_auto
    FROM qrdata WHERE is_manual = false AND digits ~ '^[0-9]+$';

  -- Only bump forward — never backward. `is_called = true` in setval
  -- semantics means the next nextval() returns (value + 1); i.e., if
  -- we set to 70024, next call returns 70025.
  IF max_manual >= 70000 THEN
    PERFORM setval('qrdata_digits_manual_seq',
                   GREATEST(max_manual, currval('qrdata_digits_manual_seq')),
                   true);
    RAISE NOTICE 'qrdata_digits_manual_seq synced to %', max_manual;
  END IF;
  IF max_auto >= 10000 THEN
    PERFORM setval('qrdata_digits_auto_seq',
                   GREATEST(max_auto, currval('qrdata_digits_auto_seq')),
                   true);
    RAISE NOTICE 'qrdata_digits_auto_seq synced to %', max_auto;
  END IF;
EXCEPTION
  WHEN OTHERS THEN
    -- currval() throws if nextval hasn't been called in this session
    -- yet. Retry without the currval GREATEST — the max_* value alone
    -- is safe to use because setval with `is_called=true` always
    -- advances the sequence.
    IF max_manual >= 70000 THEN
      PERFORM setval('qrdata_digits_manual_seq', max_manual, true);
      RAISE NOTICE 'qrdata_digits_manual_seq (fallback) synced to %', max_manual;
    END IF;
    IF max_auto >= 10000 THEN
      PERFORM setval('qrdata_digits_auto_seq', max_auto, true);
      RAISE NOTICE 'qrdata_digits_auto_seq (fallback) synced to %', max_auto;
    END IF;
END $$;
