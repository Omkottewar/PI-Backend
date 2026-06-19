-- 006_notifications.sql
CREATE TABLE IF NOT EXISTS notifications (
  id SERIAL PRIMARY KEY,
  "userId" INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title VARCHAR(255) NOT NULL,
  message TEXT NOT NULL,
  "isRead" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "sentBy" VARCHAR(255),
  "notificationType" VARCHAR(100)
);

CREATE INDEX IF NOT EXISTS idx_notifications_userId ON notifications("userId");

ALTER TABLE users ADD COLUMN IF NOT EXISTS "deviceToken" TEXT;
