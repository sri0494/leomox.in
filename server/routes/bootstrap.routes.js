// ============================================================================
// routes/bootstrap.routes.js — one call to fetch everything the HRMS
// dashboard needs right after login, scoped to what the user's role can see.
// ============================================================================
const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.get('/', requireAuth, async (req, res) => {
    const role = req.user.role;
    const canSeeUsers = role === 'admin';
    const canSeeInvoices = ['admin', 'manager'].includes(role);

    const [employees, users, invoices, siteContentRows] = await Promise.all([
        pool.query('SELECT * FROM employees ORDER BY id'),
        canSeeUsers ? pool.query('SELECT id, name, role, active, created_at FROM users ORDER BY created_at') : Promise.resolve({ rows: [] }),
        canSeeInvoices ? pool.query('SELECT * FROM invoices ORDER BY created_at DESC') : Promise.resolve({ rows: [] }),
        pool.query('SELECT key, value FROM site_content')
    ]);

    const siteContent = {};
    siteContentRows.rows.forEach(r => { siteContent[r.key] = r.value; });

    res.json({
        user: { id: req.user.id, name: req.user.name, role: req.user.role },
        employees: employees.rows,
        users: users.rows,
        invoices: invoices.rows,
        siteContent
    });
});

module.exports = router;
