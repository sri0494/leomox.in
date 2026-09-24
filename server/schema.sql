-- LeoMox IT Solutions — Neon PostgreSQL Schema
-- Run once: psql "$DATABASE_URL" -f schema.sql
-- Or paste into the Neon SQL Editor and execute.

-- ── Users ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,               -- login username e.g. "admin"
  name        TEXT        NOT NULL,
  password    TEXT        NOT NULL,           -- bcrypt hash
  role        TEXT        NOT NULL DEFAULT 'employee'
                          CHECK (role IN ('admin','manager','hr','employee')),
  active      BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Employees ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS employees (
  id          SERIAL      PRIMARY KEY,
  name        TEXT        NOT NULL,
  dept        TEXT,                           -- matches frontend field "dept"
  designation TEXT,
  phone       TEXT,
  email       TEXT,
  salary      NUMERIC(12,2) NOT NULL DEFAULT 0,
  joined      DATE,                           -- matches frontend field "joined"
  status      TEXT        NOT NULL DEFAULT 'Active'
                          CHECK (status IN ('Active','Inactive','On Leave')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Attendance ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS attendance (
  id           SERIAL      PRIMARY KEY,
  employee_id  INTEGER     NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  date         DATE        NOT NULL,
  status       TEXT        NOT NULL DEFAULT 'Present'
                           CHECK (status IN ('Present','Absent','Half Day','Leave')),
  marked_by    TEXT        REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (employee_id, date)
);

-- ── Invoices ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS invoices (
  id          SERIAL      PRIMARY KEY,
  client      TEXT        NOT NULL,
  addr        TEXT,                           -- matches frontend field "addr"
  gstin       TEXT,
  date        DATE,
  due         DATE,                           -- matches frontend field "due"
  terms       TEXT,
  status      TEXT        NOT NULL DEFAULT 'Pending'
                          CHECK (status IN ('Pending','Paid','Overdue','Cancelled')),
  items       JSONB       NOT NULL DEFAULT '[]',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Contact Requests ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS contact_requests (
  id          SERIAL      PRIMARY KEY,
  name        TEXT        NOT NULL,           -- matches frontend field "name"
  mobile      TEXT        NOT NULL,
  email       TEXT,
  service     TEXT,
  company     TEXT,
  message     TEXT,
  status      TEXT        NOT NULL DEFAULT 'New'
                          CHECK (status IN ('New','Contacted','Closed')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Site Content ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS site_content (
  key         TEXT PRIMARY KEY,
  value       JSONB       NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Default site content (hero, contact info, portal URLs)
INSERT INTO site_content (key, value) VALUES (
  'main',
  '{
    "hero_title":      "LeoMox IT Solutions",
    "hero_subtitle":   "CPaaS Platform — SMS · Voice · WhatsApp · RCS",
    "address":         "Kolanukonda, Mangalagiri, Guntur, Andhra Pradesh 522503",
    "phone":           "+91 99999 99999",
    "email":           "contact@leomox.in",
    "facebook_url":    "",
    "instagram_url":   "",
    "linkedin_url":    "",
    "youtube_url":     "",
    "sms_portal_url":  "/sms-portal.html",
    "voice_agent_url": "https://voice-agent-3mph.onrender.com/login"
  }'::jsonb
) ON CONFLICT (key) DO NOTHING;
