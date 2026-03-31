-- Emergency Alert — initial schema

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255),
  mobile VARCHAR(20) NOT NULL UNIQUE,
  email VARCHAR(255),
  age INTEGER,
  address TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS qrdata (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  unique_id UUID NOT NULL UNIQUE,
  name VARCHAR(255) NOT NULL,
  mobile VARCHAR(20) NOT NULL,
  email VARCHAR(255) NOT NULL,
  vehicle_number VARCHAR(50) NOT NULL,
  blood_group VARCHAR(20),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_qrdata_user_id ON qrdata(user_id);
CREATE INDEX IF NOT EXISTS idx_qrdata_unique_id ON qrdata(unique_id);

CREATE TABLE IF NOT EXISTS family_details (
  id SERIAL PRIMARY KEY,
  qr_id INTEGER NOT NULL REFERENCES qrdata(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  phone VARCHAR(20) NOT NULL,
  relation VARCHAR(50) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_family_qr_id ON family_details(qr_id);

CREATE TABLE IF NOT EXISTS alert_logs (
  id SERIAL PRIMARY KEY,
  qr_id INTEGER REFERENCES qrdata(id) ON DELETE SET NULL,
  caller_number VARCHAR(30) NOT NULL,
  receiver_number VARCHAR(30) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_alert_logs_qr_id ON alert_logs(qr_id);
