-- create_call_history.sql
CREATE TABLE IF NOT EXISTS "callHistory" (
  id SERIAL PRIMARY KEY,
  "userId" INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  "fromNumber" VARCHAR(20) NOT NULL,
  "toNumber" VARCHAR(20) NOT NULL,
  duration INTEGER NOT NULL,
  "callDateTime" TIMESTAMPTZ NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "idx_callHistory_userId" ON "callHistory"("userId");
