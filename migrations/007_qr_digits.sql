-- 007: Add a unique 4-digit short code to each QR (shown next to the QR image).

ALTER TABLE qrdata ADD COLUMN IF NOT EXISTS digits CHAR(4);

-- Backfill any rows that still have NULL digits using a random permutation
-- of 0000..9999. The address space is only 10,000 codes; if there are more
-- than 10,000 existing QRs the SET NOT NULL below will fail loudly.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM qrdata WHERE digits IS NULL) THEN
    WITH
      shuffled AS (
        SELECT n, ROW_NUMBER() OVER (ORDER BY random()) AS rn
        FROM generate_series(0, 9999) AS n
      ),
      to_assign AS (
        SELECT id, ROW_NUMBER() OVER (ORDER BY created_at, id) AS rn
        FROM qrdata
        WHERE digits IS NULL
      )
    UPDATE qrdata q
    SET digits = LPAD(s.n::text, 4, '0')
    FROM to_assign t
    JOIN shuffled s ON s.rn = t.rn
    WHERE q.id = t.id;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'qrdata_digits_unique'
  ) THEN
    ALTER TABLE qrdata ADD CONSTRAINT qrdata_digits_unique UNIQUE (digits);
  END IF;
END $$;

ALTER TABLE qrdata ALTER COLUMN digits SET NOT NULL;
