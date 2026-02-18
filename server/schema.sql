-- CardFlow PostgreSQL Schema
-- Run: psql -U cardflow -d cardflow -f schema.sql

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Users table (Firebase UIDs as VARCHAR PKs for migration, UUID for new)
CREATE TABLE IF NOT EXISTS users (
    id VARCHAR(128) PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255),
    name VARCHAR(255) NOT NULL DEFAULT '',
    username VARCHAR(30) UNIQUE NOT NULL,
    phone VARCHAR(50),
    photo TEXT,
    plan VARCHAR(20) NOT NULL DEFAULT 'free',
    email_verified BOOLEAN NOT NULL DEFAULT false,
    google_id VARCHAR(255),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_username ON users(username);
CREATE INDEX idx_users_google_id ON users(google_id) WHERE google_id IS NOT NULL;

-- Cards (JSONB for flexible card data)
CREATE TABLE IF NOT EXISTS cards (
    user_id VARCHAR(128) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    id VARCHAR(128) NOT NULL,
    data JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, id)
);

CREATE INDEX idx_cards_user ON cards(user_id);

-- Leads
CREATE TABLE IF NOT EXISTS leads (
    user_id VARCHAR(128) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    id VARCHAR(128) NOT NULL,
    data JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, id)
);

CREATE INDEX idx_leads_user ON leads(user_id);

-- Taps
CREATE TABLE IF NOT EXISTS taps (
    user_id VARCHAR(128) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    id VARCHAR(128) NOT NULL,
    data JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, id)
);

CREATE INDEX idx_taps_user ON taps(user_id);

-- Analytics counters
CREATE TABLE IF NOT EXISTS analytics (
    user_id VARCHAR(128) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    card_id VARCHAR(128) NOT NULL,
    metric VARCHAR(64) NOT NULL,
    data JSONB NOT NULL DEFAULT '[]',
    PRIMARY KEY (user_id, card_id, metric)
);

CREATE INDEX idx_analytics_user ON analytics(user_id);

-- User settings
CREATE TABLE IF NOT EXISTS user_settings (
    user_id VARCHAR(128) PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    default_card VARCHAR(128),
    nfc_token VARCHAR(255),
    push_subscription JSONB,
    data JSONB NOT NULL DEFAULT '{}'
);

-- Latest tap (for SSE waiting screen)
CREATE TABLE IF NOT EXISTS latest_tap (
    user_id VARCHAR(128) PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    data JSONB NOT NULL DEFAULT '{}',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Subscriptions (Stripe billing)
CREATE TABLE IF NOT EXISTS subscriptions (
    user_id VARCHAR(128) PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    stripe_customer_id VARCHAR(255),
    stripe_subscription_id VARCHAR(255),
    plan VARCHAR(20) NOT NULL DEFAULT 'free',
    status VARCHAR(30) NOT NULL DEFAULT 'none',
    current_period_end BIGINT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Public NFC tokens (lookup table)
CREATE TABLE IF NOT EXISTS public_nfc_tokens (
    token VARCHAR(255) PRIMARY KEY,
    user_id VARCHAR(128) NOT NULL REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_nfc_user ON public_nfc_tokens(user_id);

-- Password reset tokens
CREATE TABLE IF NOT EXISTS password_reset_tokens (
    token VARCHAR(255) PRIMARY KEY,
    user_id VARCHAR(128) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_reset_tokens_user ON password_reset_tokens(user_id);

-- Email verification tokens
CREATE TABLE IF NOT EXISTS email_verification_tokens (
    token VARCHAR(255) PRIMARY KEY,
    user_id VARCHAR(128) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_verify_tokens_user ON email_verification_tokens(user_id);

-- OTP codes (no FK — can be sent to unknown emails)
CREATE TABLE IF NOT EXISTS otp_codes (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) NOT NULL,
    code VARCHAR(6) NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_otp_email ON otp_codes(email);

-- Waitlist
CREATE TABLE IF NOT EXISTS waitlist (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- For existing databases: add UNIQUE constraint on waitlist.email if missing
-- (safe to re-run; DO NOTHING if constraint already exists)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conrelid = 'waitlist'::regclass AND contype = 'u'
    ) THEN
        ALTER TABLE waitlist ADD CONSTRAINT waitlist_email_unique UNIQUE (email);
    END IF;
END
$$;

-- Referral system
ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code VARCHAR(10) UNIQUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by VARCHAR(128) REFERENCES users(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS referrals (
    id SERIAL PRIMARY KEY,
    referrer_id VARCHAR(128) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    invitee_email VARCHAR(255) NOT NULL,
    invitee_id VARCHAR(128) REFERENCES users(id) ON DELETE SET NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    referrer_rewarded BOOLEAN NOT NULL DEFAULT false,
    invitee_rewarded BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    converted_at TIMESTAMPTZ,
    rewarded_at TIMESTAMPTZ,
    UNIQUE(referrer_id, invitee_email)
);
CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals(referrer_id);
CREATE INDEX IF NOT EXISTS idx_referrals_invitee_email ON referrals(invitee_email);

-- Persistent visitor identity
CREATE TABLE IF NOT EXISTS visitors (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id VARCHAR(128) REFERENCES users(id) ON DELETE SET NULL,
    device VARCHAR(20),
    browser VARCHAR(20),
    first_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    total_visits INTEGER NOT NULL DEFAULT 1,
    cards_viewed JSONB NOT NULL DEFAULT '[]',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_visitors_user ON visitors(user_id) WHERE user_id IS NOT NULL;

-- Link leads and taps to visitors
ALTER TABLE leads ADD COLUMN IF NOT EXISTS visitor_id UUID REFERENCES visitors(id) ON DELETE SET NULL;
ALTER TABLE taps ADD COLUMN IF NOT EXISTS visitor_id UUID REFERENCES visitors(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_leads_visitor ON leads(visitor_id) WHERE visitor_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_taps_visitor ON taps(visitor_id) WHERE visitor_id IS NOT NULL;

-- Two-way card exchange
CREATE TABLE IF NOT EXISTS card_exchanges (
    id SERIAL PRIMARY KEY,
    sender_user_id VARCHAR(128) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    sender_card_id VARCHAR(128) NOT NULL,
    recipient_user_id VARCHAR(128) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    recipient_card_id VARCHAR(128),
    visitor_id UUID REFERENCES visitors(id) ON DELETE SET NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_exchanges_recipient ON card_exchanges(recipient_user_id);
CREATE INDEX IF NOT EXISTS idx_exchanges_sender ON card_exchanges(sender_user_id);

-- Teams
CREATE TABLE IF NOT EXISTS teams (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(100) NOT NULL,
    owner_id VARCHAR(128) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_teams_owner ON teams(owner_id);

-- Team members
CREATE TABLE IF NOT EXISTS team_members (
    team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    user_id VARCHAR(128) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role VARCHAR(20) NOT NULL DEFAULT 'member',
    joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (team_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_team_members_user ON team_members(user_id);

-- Team invitations
CREATE TABLE IF NOT EXISTS team_invitations (
    id SERIAL PRIMARY KEY,
    team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    email VARCHAR(255) NOT NULL,
    invited_by VARCHAR(128) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(team_id, email)
);
CREATE INDEX IF NOT EXISTS idx_team_invitations_email ON team_invitations(email);

-- Add team_id to users for quick lookup
ALTER TABLE users ADD COLUMN IF NOT EXISTS team_id UUID REFERENCES teams(id) ON DELETE SET NULL;

-- Card deactivation for plan downgrades
ALTER TABLE cards ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT true;
