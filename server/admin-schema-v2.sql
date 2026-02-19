-- Super Admin Panel v2 schema additions
-- Run on VPS PostgreSQL: psql $DATABASE_URL -f admin-schema-v2.sql

-- System announcements
CREATE TABLE IF NOT EXISTS announcements (
    id SERIAL PRIMARY KEY,
    title VARCHAR(255) NOT NULL,
    body TEXT NOT NULL,
    type VARCHAR(20) DEFAULT 'info',
    active BOOLEAN DEFAULT true,
    created_by VARCHAR(128) REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ
);

-- Feature flags
CREATE TABLE IF NOT EXISTS feature_flags (
    key VARCHAR(100) PRIMARY KEY,
    enabled BOOLEAN DEFAULT false,
    description TEXT,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    updated_by VARCHAR(128) REFERENCES users(id) ON DELETE SET NULL
);

-- Indexes for subscription queries
CREATE INDEX IF NOT EXISTS idx_subscriptions_payment ON subscriptions(razorpay_payment_id) WHERE razorpay_payment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_subscriptions_updated ON subscriptions(updated_at DESC);

-- Seed default feature flags
INSERT INTO feature_flags (key, enabled, description) VALUES
    ('events_enabled', true, 'Enable the Events/Exhibition platform'),
    ('referrals_enabled', true, 'Enable the referral program'),
    ('teams_enabled', true, 'Enable team functionality'),
    ('card_exchange_enabled', true, 'Enable card exchange between users')
ON CONFLICT (key) DO NOTHING;
