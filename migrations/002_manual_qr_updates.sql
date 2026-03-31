-- Migration: Manual QR and additional columns

-- Update qrdata table
ALTER TABLE qrdata 
ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true,
ADD COLUMN IF NOT EXISTS credits INTEGER DEFAULT 50,
ADD COLUMN IF NOT EXISTS date_of_activation TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP;

-- Update users table
ALTER TABLE users 
ADD COLUMN IF NOT EXISTS manual_user BOOLEAN DEFAULT false;

-- Create manual_qr table
CREATE TABLE IF NOT EXISTS manual_qr (
  id SERIAL PRIMARY KEY,
  qr_unique_id UUID NOT NULL UNIQUE,
  is_active BOOLEAN DEFAULT true,
  referral_code VARCHAR(50) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
