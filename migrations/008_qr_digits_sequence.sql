-- 008: Switch qrdata.digits from random allocation to a backend-driven
-- sequence so each new QR gets the next 4-digit code (0001, 0002, ...).

CREATE SEQUENCE IF NOT EXISTS qrdata_digits_seq
  AS INTEGER
  MINVALUE 1
  MAXVALUE 9999
  START WITH 1;

-- Make sure bounds are right even if the sequence already existed from
-- a prior run with different settings.
ALTER SEQUENCE qrdata_digits_seq MAXVALUE 9999 MINVALUE 1;

-- Re-sequence existing rows in creation order. We drop the unique
-- constraint for the duration of the swap since Postgres checks
-- uniqueness immediately per-row and intermediate states would clash.
ALTER TABLE qrdata DROP CONSTRAINT IF EXISTS qrdata_digits_unique;

WITH numbered AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY created_at, id) AS rn
  FROM qrdata
)
UPDATE qrdata q
SET digits = LPAD(n.rn::text, 4, '0')
FROM numbered n
WHERE q.id = n.id;

ALTER TABLE qrdata ADD CONSTRAINT qrdata_digits_unique UNIQUE (digits);

-- Position the sequence so the next nextval() returns MAX(digits) + 1,
-- or 1 if the table is empty.
DO $$
DECLARE
  max_d INT := (SELECT COALESCE(MAX(digits::int), 0) FROM qrdata);
BEGIN
  IF max_d > 0 THEN
    PERFORM setval('qrdata_digits_seq', max_d, true);
  ELSE
    PERFORM setval('qrdata_digits_seq', 1, false);
  END IF;
END $$;
