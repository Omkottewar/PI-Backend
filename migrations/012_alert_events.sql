-- 012: Bystander scan-tap events with optional geolocation.
--   Every time a bystander taps a contact card on the alert page, one row
--   is inserted here. Location is optional (nullable) so the feature
--   degrades gracefully when the bystander denies the browser prompt.
--
--   Retention: intended to be pruned to 90 days by the listing query
--   itself (WHERE created_at > NOW() - INTERVAL '90 days'). No cron
--   needed — old rows sit until deleted or a future cleanup job runs.

CREATE TABLE IF NOT EXISTS alert_events (
  id SERIAL PRIMARY KEY,
  qr_id INTEGER NOT NULL REFERENCES qrdata(id) ON DELETE CASCADE,
  contact_kind VARCHAR(10),
    -- 'owner' | 'family' — which card the bystander tapped
  contact_family_id INTEGER
    REFERENCES family_details(id) ON DELETE SET NULL,
  latitude DOUBLE PRECISION,          -- NULL if bystander denied location
  longitude DOUBLE PRECISION,         -- NULL if bystander denied location
  accuracy_meters DOUBLE PRECISION,   -- from the Geolocation API
  user_agent TEXT,                    -- rough device/browser fingerprint
  seen_at TIMESTAMPTZ,                -- set when the owner dismisses / views
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_alert_events_qr
  ON alert_events(qr_id, created_at DESC);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'alert_events_kind_check'
  ) THEN
    ALTER TABLE alert_events
      ADD CONSTRAINT alert_events_kind_check
      CHECK (contact_kind IS NULL OR contact_kind IN ('owner', 'family'));
  END IF;
END $$;
