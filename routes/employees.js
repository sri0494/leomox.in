'use strict';
const express  = require('express');
const { sql }  = require('../db');
const { requireAuth } = require('../middleware/auth');
const router   = express.Router();

/* GET /api/employees */
router.get('/', requireAuth, async (req, res) => {
  try {
    const rows = await sql`SELECT * FROM employees ORDER BY created_at DESC`;
    res.json(rows);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

/* POST /api/employees */
router.post('/', requireAuth, async (req, res) => {
  try {
    const { emp_id, name, designation, department, email, phone, join_date, status } = req.body;
    if (!emp_id || !name) return res.status(400).json({ error: 'emp_id and name are required' });
    const [row] = await sql`
      INSERT INTO employees (emp_id, name, designation, department, email, phone, join_date, status)
      VALUES (${emp_id}, ${name}, ${designation||null}, ${department||null}, ${email||null}, ${phone||null}, ${join_date||null}, ${status||'Active'})
      RETURNING *
    `;
    res.status(201).json(row);
  } catch (err) {
    if (err.message.includes('duplicate')) return res.status(409).json({ error: 'Employee ID already exists' });
    res.status(500).json({ error: 'Server error' });
  }
});

/* PUT /api/employees/:id */
router.put('/:id', requireAuth, async (req, res) => {
  try {
    const { name, designation, department, email, phone, join_date, status } = req.body;
    const [row] = await sql`
      UPDATE employees SET
        name=${name}, designation=${designation||null}, department=${department||null},
        email=${email||null}, phone=${phone||null}, join_date=${join_date||null}, status=${status||'Active'}
      WHERE emp_id = ${req.params.id}
      RETURNING *
    `;
    if (!row) return res.status(404).json({ error: 'Employee not found' });
    res.json(row);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

/* DELETE /api/employees/:id */
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    await sql`DELETE FROM employees WHERE emp_id = ${req.params.id}`;
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

module.exports = router;
