'use strict';
const express = require('express');
const bcrypt  = require('bcryptjs');
const { sql } = require('../db');
const { requireAdmin, requireAdminHR } = require('../middleware/auth');
const { pgMessage } = require('../utils/employee');
const audit   = require('../utils/audit');

const router = express.Router();
const VALID_ROLES = ['admin', 'manager', 'hr', 'employee'];

// Every route here maps 1:1 to the "Users" tab in index.html, which is
// only ever shown to the admin role (can('users') === true only for admin),
// so every endpoint below is admin-only.

// GET /api/users/options — active logins + which employee (if any) each is linked to.
// Used by the Employee form's "Login user" dropdown (admin and HR).
router.get('/options', requireAdminHR, async (req, res) => {
  try {
    res.json(await sql`SELECT u.id, u.name, u.role, e.id AS employee_id
                       FROM users u LEFT JOIN employees e ON e.user_id = u.id
                       WHERE u.active = TRUE ORDER BY u.id`);
  } catch (err) {
    console.error('User options error:', err);
    res.status(500).json({ error: 'Failed to load users' });
  }
});

// GET /api/users
router.get('/', requireAdmin, async (req, res) => {
  try {
    const rows = await sql`SELECT id, name, role, active, created_at FROM users ORDER BY created_at DESC`;
    res.json(rows);
  } catch (err) {
    console.error('List users error:', err);
    res.status(500).json({ error: 'Failed to load users' });
  }
});

// POST /api/users
router.post('/', requireAdmin, async (req, res) => {
  try {
    const { id, name, password, role } = req.body || {};
    if (!id || !name || !password || !role) {
      return res.status(400).json({ error: 'id, name, password and role are required' });
    }
    const cleanId = String(id).trim();
    if (!/^[a-zA-Z0-9_-]{2,32}$/.test(cleanId)) {
      return res.status(400).json({ error: 'User ID may only contain letters, numbers, hyphens and underscores (2-32 characters).' });
    }
    if (String(password).length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }
    if (!VALID_ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role' });

    const existing = await sql`SELECT id FROM users WHERE id = ${cleanId}`;
    if (existing.length) return res.status(409).json({ error: 'A user with this ID already exists' });

    const hash = await bcrypt.hash(String(password), 12);
    const rows = await sql`
      INSERT INTO users (id, name, password, role)
      VALUES (${cleanId}, ${String(name).trim()}, ${hash}, ${role})
      RETURNING id, name, role, active, created_at
    `;
    await audit.log(req, { action: 'create', module: 'users', recordId: cleanId, newValue: rows[0] });
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('Create user error:', err);
    res.status(500).json({ error: 'Failed to create user' });
  }
});

// PUT /api/users/:id
router.put('/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, role, password } = req.body || {};

    const rows0 = await sql`SELECT * FROM users WHERE id = ${id}`;
    const existing = rows0[0];
    if (!existing) return res.status(404).json({ error: 'User not found' });

    if (role && !VALID_ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role' });
    if (id === 'admin' && role && role !== 'admin') {
      return res.status(400).json({ error: 'Cannot change the role of the super admin account' });
    }

    const newName = name && String(name).trim() ? String(name).trim() : existing.name;
    const newRole = role || existing.role;
    let passwordHash = existing.password;
    if (password) {
      if (String(password).length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
      passwordHash = await bcrypt.hash(String(password), 12);
    }

    const rows = await sql`
      UPDATE users SET name = ${newName}, role = ${newRole}, password = ${passwordHash}
      WHERE id = ${id}
      RETURNING id, name, role, active, created_at
    `;
    await audit.log(req, {
      action: 'update', module: 'users', recordId: id,
      oldValue: { name: existing.name, role: existing.role },
      newValue: rows[0]
    });
    res.json(rows[0]);
  } catch (err) {
    console.error('Update user error:', err);
    res.status(500).json({ error: 'Failed to update user' });
  }
});

// POST /api/users/:id/toggle-active
router.post('/:id/toggle-active', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    if (id === 'admin') return res.status(400).json({ error: 'Cannot disable the super admin account' });
    if (id === req.user.id) return res.status(400).json({ error: 'You cannot disable your own account' });

    const rows0 = await sql`SELECT * FROM users WHERE id = ${id}`;
    const existing = rows0[0];
    if (!existing) return res.status(404).json({ error: 'User not found' });

    const rows = await sql`
      UPDATE users SET active = ${!existing.active} WHERE id = ${id}
      RETURNING id, name, role, active, created_at
    `;
    await audit.log(req, { action: existing.active ? 'disable' : 'enable', module: 'users', recordId: id });
    res.json(rows[0]);
  } catch (err) {
    console.error('Toggle user error:', err);
    res.status(500).json({ error: 'Failed to update user' });
  }
});

// DELETE /api/users/:id
router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    if (id === 'admin') return res.status(400).json({ error: 'Cannot delete the super admin account' });

    const rows0 = await sql`SELECT id FROM users WHERE id = ${id}`;
    if (!rows0.length) return res.status(404).json({ error: 'User not found' });

    if (id === req.user.id) return res.status(400).json({ error: 'You cannot delete your own account' });
    await sql`UPDATE employees SET user_id = NULL WHERE user_id = ${id}`;
    await sql`DELETE FROM users WHERE id = ${id}`;
    await audit.log(req, { action: 'delete', module: 'users', recordId: id });
    res.json({ ok: true });
  } catch (err) {
    console.error('Delete user error:', err);
    if (err && err.code === '23503') {
      return res.status(409).json({ error: 'This user is referenced by other records. Run "npm run db:migrate" once, or disable the account instead of deleting it.' });
    }
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

module.exports = router;
