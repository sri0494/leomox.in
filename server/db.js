// ============================================================================
// db.js — Postgres connection pool, configured for Neon.
//
// Neon connection strings already include `sslmode=require`, but we set the
// ssl option explicitly too so this also works against Neon's pooled
// connection string (the one ending in "-pooler") and against other hosts
// that need SSL without a locally-trusted CA chain.
// ============================================================================
const { Pool, types } = require('pg');

// By default node-postgres parses DATE columns into JS Date objects (in the
// server's local timezone), which both mangles the value on display (e.g.
// "Thu Jan 15 2024 00:00:00 GMT+0000...") and risks off-by-one-day bugs
// across timezones. We want plain 'YYYY-MM-DD' strings — exactly what the
// frontend's <input type="date"> fields and templates already expect —
// so we disable that conversion for the DATE type (OID 1082).
types.setTypeParser(1082, (val) => val);

// NUMERIC/DECIMAL columns (e.g. salary) come back as strings by default too,
// to avoid silent floating-point precision loss. We keep that default and
// instead coerce to numbers explicitly wherever needed (see the frontend's
// normalizeEmployee()), which is the safer direction for money values.

if (!process.env.DATABASE_URL) {
    console.error('Missing DATABASE_URL environment variable. Copy .env.example to .env and set it to your Neon connection string.');
    process.exit(1);
}

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
});

pool.on('error', (err) => {
    console.error('Unexpected Postgres pool error:', err);
});

module.exports = { pool };
