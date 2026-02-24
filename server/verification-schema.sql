-- Card Verification Schema
-- Run: psql -U cardflow -d cardflow -f verification-schema.sql

-- Add verified_at to cards for fast public lookups
ALTER TABLE cards ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ DEFAULT NULL;

-- Card verification requests (audit trail)
CREATE TABLE IF NOT EXISTS card_verifications (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(128) NOT NULL,
    card_id VARCHAR(128) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    card_email VARCHAR(255),
    email_verified BOOLEAN NOT NULL DEFAULT false,
    documents JSONB NOT NULL DEFAULT '[]',
    ai_result JSONB,
    admin_id VARCHAR(128) REFERENCES users(id) ON DELETE SET NULL,
    admin_note TEXT,
    rejection_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    reviewed_at TIMESTAMPTZ,
    FOREIGN KEY (user_id, card_id) REFERENCES cards(user_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_cv_user_card ON card_verifications(user_id, card_id);
CREATE INDEX IF NOT EXISTS idx_cv_status ON card_verifications(status);
CREATE INDEX IF NOT EXISTS idx_cv_created ON card_verifications(created_at DESC);

-- Add purpose to OTP codes to distinguish login vs card_verify
ALTER TABLE otp_codes ADD COLUMN IF NOT EXISTS purpose VARCHAR(20) NOT NULL DEFAULT 'login';
