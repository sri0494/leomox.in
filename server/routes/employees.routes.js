// ============================================================================
// routes/employees.routes.js
// ============================================================================
const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

function nextEmployeeId(rows) {
    const nums = rows.map(r => parseInt(String(r.id).replace(/\D/g, ''), 10)).filter(n => !isNaN(n));
    const next = (nums.length ? Math.max(...nums) : 0) + 1;
    return 'EMP' + String(next).padStart(3, '0');
}

// All HRMS roles can view employees
router.get('/', requireAuth, async (req, res) => {
    const { rows } = await pool.query('SELECT * FROM employees ORDER BY id');
    res.json(rows);
});

// Only admin/manager/hr can create or edit employees
router.post('/', requireAuth, requireRole('admin', 'manager', 'hr'), async (req, res) => {
    const { name, dept, designation, phone, email, salary, joined, status } = req.body || {};
    if (!name) return res.status(400).json({ error: 'Name is required.' });

    const { rows: existing } = await pool.query('SELECT id FROM employees');
    const id = nextEmployeeId(existing);

    const { rows } = await pool.query(
        `INSERT INTO employees (id, name, dept, designation, phone, email, salary, joined, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [id, name, dept || '', designation || '', phone || '', email || '', salary || 0, joined || null, status || 'Active']
    );
    res.status(201).json(rows[0]);
});

router.put('/:id', requireAuth, requireRole('admin', 'manager', 'hr'), async (req, res) => {
    const { name, dept, designation, phone, email, salary, joined, status } = req.body || {};
    const { rows } = await pool.query(
        `UPDATE employees SET name=$1, dept=$2, designation=$3, phone=$4, email=$5,
            salary=$6, joined=$7, status=$8, updated_at=now()
         WHERE id=$9 RETURNING *`,
        [name, dept || '', designation || '', phone || '', email || '', salary || 0, joined || null, status || 'Active', req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Employee not found.' });
    res.json(rows[0]);
});

router.delete('/:id', requireAuth, requireRole('admin', 'manager'), async (req, res) => {
    await pool.query('DELETE FROM employees WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
});

module.exports = router;
