'use strict';
/**
 * Applies schema.sql, migrate.sql and migrate_v2.sql (in that order) to the
 * database in DATABASE_URL. Every statement is idempotent, so it is safe to
 * run on every deploy:   npm run db:migrate
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { sql } = require('../db');
const { splitSql } = require('../utils/sqlsplit');

const FILES = ['schema.sql', 'migrate.sql', 'migrate_v2.sql', 'migrate_v3.sql'];

// neon() >= 1.0 requires sql.query(text); 0.9.x accepts sql(text).
const run = (text) => (typeof sql.query === 'function' ? sql.query(text) : sql(text));

(async () => {
  let total = 0;
  for (const f of FILES) {
    const statements = splitSql(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'));
    console.log(`▶ ${f} — ${statements.length} statements`);
    for (const [idx, stmt] of statements.entries()) {
      try { await run(stmt); total++; }
      catch (err) {
        console.error(`\n✗ ${f} statement #${idx + 1} failed:\n${stmt.slice(0, 300)}\n\n${err.message}`);
        process.exit(1);
      }
    }
  }
  console.log(`\n✓ Migration complete (${total} statements applied).`);
  process.exit(0);
})();
