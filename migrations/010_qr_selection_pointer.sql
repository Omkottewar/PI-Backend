-- 010: Add a "selected contact" pointer to qrdata so the bystander's choice
-- of which contact to bridge the call to is stored per-QR.
--
-- Story A / global pointer:
--   • Selection is required — dialer only opens after a successful select.
--   • Selection expires after 30 minutes (enforced in the IVR lookup query,
--     not by a scheduled job — no cron dependency).
--   • If the pointer targets a family_details row that gets deleted, the FK
--     ON DELETE SET NULL nulls the reference and the IVR falls back to the
--     owner's mobile automatically.

ALTER TABLE qrdata
  ADD COLUMN IF NOT EXISTS selected_contact_kind VARCHAR(10);
  -- Values: 'owner', 'family', or NULL when nothing has been picked yet.

ALTER TABLE qrdata
  ADD COLUMN IF NOT EXISTS selected_family_id INTEGER
    REFERENCES family_details(id) ON DELETE SET NULL;

ALTER TABLE qrdata
  ADD COLUMN IF NOT EXISTS selected_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'qrdata_selected_kind_check'
  ) THEN
    ALTER TABLE qrdata
      ADD CONSTRAINT qrdata_selected_kind_check
      CHECK (selected_contact_kind IS NULL
             OR selected_contact_kind IN ('owner', 'family'));
  END IF;
END $$;
