-- CardFlow Events — Exhibition & Trade Show Platform
-- Run: psql -U cardflow -d cardflow -f events-schema.sql

-- Add role column to users (user, organizer, admin)
ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(20) DEFAULT 'user';

-- Events
CREATE TABLE IF NOT EXISTS events (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organizer_id VARCHAR(128) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    slug VARCHAR(100) UNIQUE NOT NULL,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    venue VARCHAR(255),
    address TEXT,
    city VARCHAR(100),
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    logo TEXT,
    cover_image TEXT,
    branding JSONB DEFAULT '{}',
    categories JSONB DEFAULT '[]',
    floor_plan_image TEXT,
    settings JSONB DEFAULT '{}',
    status VARCHAR(20) DEFAULT 'draft',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_events_organizer ON events(organizer_id);
CREATE INDEX IF NOT EXISTS idx_events_slug ON events(slug);
CREATE INDEX IF NOT EXISTS idx_events_status ON events(status);

-- Exhibitors (links a user to an event with booth info)
CREATE TABLE IF NOT EXISTS event_exhibitors (
    id SERIAL PRIMARY KEY,
    event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    user_id VARCHAR(128) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    booth_number VARCHAR(50),
    booth_size VARCHAR(20),
    category VARCHAR(100),
    company_name VARCHAR(255),
    company_description TEXT,
    products JSONB DEFAULT '[]',
    brochure_url TEXT,
    logo TEXT,
    website VARCHAR(255),
    status VARCHAR(20) DEFAULT 'pending',
    settings JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(event_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_exhibitors_event ON event_exhibitors(event_id);
CREATE INDEX IF NOT EXISTS idx_exhibitors_user ON event_exhibitors(user_id);

-- Attendees (visitors who register for an event)
CREATE TABLE IF NOT EXISTS event_attendees (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255),
    phone VARCHAR(50),
    company VARCHAR(255),
    title VARCHAR(255),
    badge_code VARCHAR(20) UNIQUE,
    visitor_id UUID REFERENCES visitors(id) ON DELETE SET NULL,
    data JSONB DEFAULT '{}',
    registered_at TIMESTAMPTZ DEFAULT NOW(),
    checked_in_at TIMESTAMPTZ,
    UNIQUE(event_id, email)
);
CREATE INDEX IF NOT EXISTS idx_attendees_event ON event_attendees(event_id);
CREATE INDEX IF NOT EXISTS idx_attendees_badge ON event_attendees(badge_code);
CREATE INDEX IF NOT EXISTS idx_attendees_email ON event_attendees(email);

-- Booth visits (when attendee badge is scanned at a booth)
CREATE TABLE IF NOT EXISTS booth_visits (
    id SERIAL PRIMARY KEY,
    event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    exhibitor_id INTEGER NOT NULL REFERENCES event_exhibitors(id) ON DELETE CASCADE,
    attendee_id UUID REFERENCES event_attendees(id) ON DELETE SET NULL,
    visitor_id UUID REFERENCES visitors(id) ON DELETE SET NULL,
    scanned_by VARCHAR(128) REFERENCES users(id) ON DELETE SET NULL,
    data JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_booth_visits_event ON booth_visits(event_id);
CREATE INDEX IF NOT EXISTS idx_booth_visits_exhibitor ON booth_visits(exhibitor_id);
CREATE INDEX IF NOT EXISTS idx_booth_visits_attendee ON booth_visits(attendee_id);
