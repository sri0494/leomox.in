'use strict';
require('dotenv').config();
const bcrypt = require('bcryptjs');
const { sql } = require('./db');

const ACCOUNTS = [
  { id: 'admin',    name: 'LeoMox Admin',   password: 'leomox@123', role: 'admin'    },
  { id: 'manager1', name: 'Manager One',     password: 'mgr@123',    role: 'manager'  },
  { id: 'hr1',      name: 'HR Executive',    password: 'hr@123',     role: 'hr'       },
  { id: 'emp1',     name: 'Employee One',    password: 'emp@123',    role: 'employee' },
];

async function seed() {
  console.log('Seeding default accounts…');
  for (const acc of ACCOUNTS) {
    const hash = await bcrypt.hash(acc.password, 12);
    await sql`
      INSERT INTO users (id, name, password, role)
      VALUES (${acc.id}, ${acc.name}, ${hash}, ${acc.role})
      ON CONFLICT (id) DO NOTHING
    `;
    console.log(`  ✓ ${acc.id} (${acc.role})`);
  }
  console.log('Done. Change these passwords after first login!');
  process.exit(0);
}

seed().catch(err => { console.error(err); process.exit(1); });
