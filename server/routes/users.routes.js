'use strict';
const express = require('express');
const bcrypt  = require('bcryptjs');
const { sql } = require('../db');
const { requireAdmin } = require('../middleware/auth');
const router  = express.Router();

/* GET /api/users */
router.get('/', requireAdmin, async (req, res) => {
  try {
    const rows = await sql`SELECT id, name, role, active, created_at FROM users ORDER BY created_at DESC`;
    res.json(rows);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

/* POST /api/users */
router.post('/', requireAdmin, async (req, res) => {
  try {
    const { id, name, password, role } = req.body;
    if (!id || !name || !password) return res.status(400).json({ error: 'id, name and password required' });
    if (!['admin','manager','hr','employee'].includes(role)) return res.status(400).json({ error: 'Invalid role' });

    const hashed = await bcrypt.hash(password, 12);
    const [user] = await sql`
      INSERT INTO users (id, name, password, role)
      VALUES (${id}, ${name}, ${hashed}, ${role})
      RETURNING id, name, role, active, created_at
    `;
    res.status(201).json(user);
  } catch (err) {
    if (err.message.includes('duplicate') || err.message.includes('unique')) {
      return res.status(409).json({ error: 'User ID already exists' });
    }
    res.status(500).json({ error: 'Server error' });
  }
});

/* PUT /api/users/:id */
router.put('/:id', requireAdmin, async (req, res) => {
  try {
    const { name, role, password } = req.body;
    if (password) {
      const hashed = await bcrypt.hash(password, 12);
      const [u] = await sql`
        UPDATE users SET name=${name}, role=${role}, password=${hashed}
        WHERE id=${req.params.id} RETURNING id, name, role, active
      `;
      return res.json(u);
    }
    const [u] = await sql`
      UPDATE users SET name=${name}, role=${role}
      WHERE id=${req.params.id} RETURNING id, name, role, active
    `;
    if (!u) return res.status(404).json({ error: 'User not found' });
    res.json(u);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

/* POST /api/users/:id/toggle-active */
router.post('/:id/toggle-active', requireAdmin, async (req, res) => {
  try {
    const [u] = await sql`
      UPDATE users SET active = NOT active
      WHERE id = ${req.params.id}
      RETURNING id, name, role, active
    `;
    if (!u) return res.status(404).json({ error: 'User not found' });
    res.json(u);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

/* DELETE /api/users/:id */
router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    await sql`DELETE FROM users WHERE id = ${req.params.id}`;
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

module.exports = router;
