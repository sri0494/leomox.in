'use strict';
const express = require('express');
const { sql } = require('../db');
const { requireAuth, requireHR } = require('../middleware/auth');
const router  = express.Router();

/* GET /api/employees */
router.get('/', requireAuth, async (req, res) => {
  try {
    const rows = await sql`SELECT * FROM employees ORDER BY created_at DESC`;
    res.json(rows);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

/* POST /api/employees */
router.post('/', requireHR, async (req, res) => {
  try {
    const { name, dept, designation, phone, email, salary, joined, status } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    const [row] = await sql`
      INSERT INTO employees (name, dept, designation, phone, email, salary, joined, status)
      VALUES (
        ${name},
        ${dept        || null},
        ${designation || null},
        ${phone       || null},
        ${email       || null},
        ${salary      || 0},
        ${joined      || null},
        ${status      || 'Active'}
      )
      RETURNING *
    `;
    res.status(201).json(row);
  } catch (err) {
    console.error('Employee POST error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/* PUT /api/employees/:id */
router.put('/:id', requireHR, async (req, res) => {
  try {
    const { name, dept, designation, phone, email, salary, joined, status } = req.body;
    const [row] = await sql`
      UPDATE employees SET
        name        = ${name},
        dept        = ${dept        || null},
        designation = ${designation || null},
        phone       = ${phone       || null},
        email       = ${email       || null},
        salary      = ${salary      || 0},
        joined      = ${joined      || null},
        status      = ${status      || 'Active'}
      WHERE id = ${req.params.id}
      RETURNING *
    `;
    if (!row) return res.status(404).json({ error: 'Employee not found' });
    res.json(row);
  } catch (err) {
    console.error('Employee PUT error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/* DELETE /api/employees/:id */
router.delete('/:id', requireHR, async (req, res) => {
  try {
    await sql`DELETE FROM employees WHERE id = ${req.params.id}`;
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

module.exports = router;
