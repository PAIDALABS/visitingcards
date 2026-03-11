-- Analytics Events table
-- Tracks user actions across the platform (GA-style events)

CREATE TABLE IF NOT EXISTS analytics_events (
    id BIGSERIAL PRIMARY KEY,
    event_name VARCHAR(64) NOT NULL,
    user_id VARCHAR(128) REFERENCES users(id) ON DELETE SET NULL,
    properties JSONB DEFAULT '{}',
    referrer TEXT,
    user_agent TEXT,
    ip VARCHAR(45),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_ae_event_name ON analytics_events(event_name);
CREATE INDEX idx_ae_user_id ON analytics_events(user_id);
CREATE INDEX idx_ae_created_at ON analytics_events(created_at DESC);
CREATE INDEX idx_ae_event_date ON analytics_events(event_name, created_at DESC);
