'use strict';
const { neon } = require('@neondatabase/serverless');
require('dotenv').config();

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set in environment variables');
}

const sql = neon(process.env.DATABASE_URL);

/* ── Bootstrap: create all tables if they don't exist ── */
async function bootstrap() {
  await sql`
    CREATE TABLE IF NOT EXISTS users (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      password    TEXT NOT NULL,
      role        TEXT NOT NULL DEFAULT 'user',
      active      BOOLEAN NOT NULL DEFAULT TRUE,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS employees (
      id          SERIAL PRIMARY KEY,
      emp_id      TEXT UNIQUE NOT NULL,
      name        TEXT NOT NULL,
      designation TEXT,
      department  TEXT,
      email       TEXT,
      phone       TEXT,
      join_date   DATE,
      status      TEXT DEFAULT 'Active',
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS attendance (
      id          SERIAL PRIMARY KEY,
      employee_id TEXT NOT NULL,
      date        DATE NOT NULL,
      status      TEXT NOT NULL DEFAULT 'Present',
      marked_by   TEXT,
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(employee_id, date)
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS invoices (
      id          SERIAL PRIMARY KEY,
      client      TEXT NOT NULL,
      address     TEXT,
      gstin       TEXT,
      date        DATE,
      due_date    DATE,
      terms       TEXT,
      status      TEXT DEFAULT 'Pending',
      items       JSONB DEFAULT '[]',
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS contacts (
      id          SERIAL PRIMARY KEY,
      firstname   TEXT,
      lastname    TEXT,
      mobile      TEXT,
      email       TEXT,
      company     TEXT,
      service     TEXT,
      message     TEXT,
      status      TEXT DEFAULT 'New',
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS site_content (
      key         TEXT PRIMARY KEY,
      value       JSONB NOT NULL,
      updated_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS refresh_tokens (
      id          SERIAL PRIMARY KEY,
      user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token       TEXT NOT NULL UNIQUE,
      expires_at  TIMESTAMPTZ NOT NULL,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `;

  console.log('✅ Database schema ready');
}

module.exports = { sql, bootstrap };
