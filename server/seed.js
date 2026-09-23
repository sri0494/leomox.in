// ============================================================================
// seed.js — creates the default HRMS accounts and a small set of demo data.
// Run once after the schema has been applied:
//   node seed.js
// Safe to re-run: uses ON CONFLICT DO NOTHING / UPSERT so it won't duplicate
// or clobber data you've since changed via the app.
// ============================================================================
require('dotenv').config();
const bcrypt = require('bcryptjs');
const { pool } = require('./db');

const DEFAULT_USERS = [
    { id: 'admin',    name: 'Super Admin',  role: 'admin',    password: 'leomox@123' },
    { id: 'manager1', name: 'Ravi Kumar',   role: 'manager',  password: 'mgr@123' },
    { id: 'hr1',      name: 'Priya Sharma', role: 'hr',       password: 'hr@123' },
    { id: 'emp1',     name: 'Arjun Reddy',  role: 'employee', password: 'emp@123' }
];

const DEFAULT_EMPLOYEES = [
    { id: 'EMP001', name: 'Arjun Reddy',  dept: 'Sales',       designation: 'Sales Executive',  phone: '9000000001', email: 'arjun@leomox.in',  salary: 25000, joined: '2023-01-15', status: 'Active' },
    { id: 'EMP002', name: 'Priya Sharma', dept: 'HR',          designation: 'HR Manager',       phone: '9000000002', email: 'priya@leomox.in',  salary: 45000, joined: '2022-06-01', status: 'Active' },
    { id: 'EMP003', name: 'Ravi Kumar',   dept: 'Operations',  designation: 'Operations Manager',phone: '9000000003', email: 'ravi@leomox.in',   salary: 55000, joined: '2021-03-10', status: 'Active' }
];

async function seed() {
    console.log('Seeding default users...');
    for (const u of DEFAULT_USERS) {
        const hash = await bcrypt.hash(u.password, 12);
        await pool.query(
            `INSERT INTO users (id, name, password_hash, role, active)
             VALUES ($1, $2, $3, $4, true)
             ON CONFLICT (id) DO NOTHING`,
            [u.id, u.name, hash, u.role]
        );
    }

    console.log('Seeding demo employees...');
    for (const e of DEFAULT_EMPLOYEES) {
        await pool.query(
            `INSERT INTO employees (id, name, dept, designation, phone, email, salary, joined, status)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
             ON CONFLICT (id) DO NOTHING`,
            [e.id, e.name, e.dept, e.designation, e.phone, e.email, e.salary, e.joined, e.status]
        );
    }

    console.log('Done. Default login: admin / leomox@123 (change this immediately after first login).');
    await pool.end();
}

seed().catch((err) => {
    console.error('Seed failed:', err);
    process.exit(1);
});
