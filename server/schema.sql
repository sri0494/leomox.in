-- ============================================================================
-- LeoMox IT Solutions — Database schema (PostgreSQL / Neon)
-- Run this once against your Neon database before starting the server.
--   psql "$DATABASE_URL" -f schema.sql
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto; -- for gen_random_uuid()

-- ── Users (HRMS login accounts: admin / manager / hr / employee) ───────────
CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,               -- e.g. 'admin', 'hr1'
    name          TEXT NOT NULL,
    password_hash TEXT NOT NULL,                   -- bcrypt hash, server-side only
    role          TEXT NOT NULL CHECK (role IN ('admin','manager','hr','employee')),
    active        BOOLEAN NOT NULL DEFAULT true,
    failed_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until  TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Employees ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS employees (
    id          TEXT PRIMARY KEY,                  -- e.g. 'EMP001'
    name        TEXT NOT NULL,
    dept        TEXT,
    designation TEXT,
    phone       TEXT,
    email       TEXT,
    salary      NUMERIC(12,2) NOT NULL DEFAULT 0,
    joined      DATE,
    status      TEXT NOT NULL DEFAULT 'Active' CHECK (status IN ('Active','Inactive')),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Attendance ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS attendance (
    id          SERIAL PRIMARY KEY,
    employee_id TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    date        DATE NOT NULL DEFAULT CURRENT_DATE,
    status      TEXT NOT NULL DEFAULT 'Present' CHECK (status IN ('Present','Absent','Leave','Half Day')),
    UNIQUE (employee_id, date)
);

-- ── Invoices ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS invoices (
    id          TEXT PRIMARY KEY,                  -- e.g. 'INV1001'
    client      TEXT,
    addr        TEXT,
    gstin       TEXT,
    date        DATE NOT NULL DEFAULT CURRENT_DATE,
    due         DATE,
    status      TEXT NOT NULL DEFAULT 'Pending' CHECK (status IN ('Paid','Pending')),
    terms       TEXT,
    items       JSONB NOT NULL DEFAULT '[]',        -- [{ desc, qty, rate }]
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Site content (editable public-site copy: hero text, contact info, etc.) ─
CREATE TABLE IF NOT EXISTS site_content (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT ''
);

-- ── Contact form / lead submissions ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS contact_requests (
    id         SERIAL PRIMARY KEY,
    name       TEXT NOT NULL,
    mobile     TEXT NOT NULL,
    email      TEXT,
    service    TEXT,
    company    TEXT,
    message    TEXT,
    status     TEXT NOT NULL DEFAULT 'New' CHECK (status IN ('New','Contacted','Closed')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_attendance_date ON attendance(date);
CREATE INDEX IF NOT EXISTS idx_contact_requests_created ON contact_requests(created_at DESC);

-- ── Default site content (safe to re-run: ON CONFLICT DO NOTHING) ───────────
INSERT INTO site_content (key, value) VALUES
    ('hero_title',        'Innovative Digital &'),
    ('hero_subtitle',     'SMS Solutions'),
    ('hero_description',  'Empowering your business with Promotional, Transactional, and OTP SMS services alongside cutting-edge Website Development tailored for growth.'),
    ('about_title',       'Who We Are'),
    ('about_description', 'Pioneering Digital Communication Solutions Since Our Inception'),
    ('company_name',      'LeoMox IT Solutions'),
    ('phone',             '+91 9491401514'),
    ('email',             'info@leomox.in'),
    ('working_hours',     'Mon-Sat, 9:00 AM - 6:00 PM'),
    ('address',           'Kolanukonda, Mangalagiri, Guntur, Andhra Pradesh - 522503'),
    ('tagline',           'Trusted partner for IT and Communication solutions. We help businesses connect and grow.'),
    ('stat_uptime',       '99.9%'),
    ('stat_delivered',    '2M+'),
    ('stat_clients',      '10+'),
    ('facebook_url',      ''),
    ('instagram_url',     ''),
    ('linkedin_url',      ''),
    ('youtube_url',       '')
ON CONFLICT (key) DO NOTHING;
