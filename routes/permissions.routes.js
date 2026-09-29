'use strict';
// NOTE: index.html's role/module gating is hardcoded client-side in
// HRMS.roles and doesn't call this API today. This exposes the
// permissions/user_permissions tables from migrate.sql (and the
// getUserPermissions() helper in middleware/permissions.js) for a future
// per-user permission-override UI.
const express = require('express');
const { sql } = require('../db');
const { requireAdmin } = require('../middleware/auth');
const { getUserPermissions } = require('../middleware/permissions');
const audit   = require('../utils/audit');

const router = express.Router();

// GET /api/permissions — the full permission catalog
router.get('/', requireAdmin, async (req, res) => {
  try {
    const rows = await sql`SELECT * FROM permissions ORDER BY category, label`;
    res.json(rows);
  } catch (err) {
    console.error('List permissions error:', err);
    res.status(500).json({ error: 'Failed to load permissions' });
  }
});

// GET /api/permissions/users/:id — a user's explicit overrides + effective merged list
router.get('/users/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const userRows = await sql`SELECT id, role FROM users WHERE id = ${id}`;
    if (!userRows.length) return res.status(404).json({ error: 'User not found' });

    const overrides = await sql`SELECT * FROM user_permissions WHERE user_id = ${id}`;
    const effective = await getUserPermissions(id, userRows[0].role);
    res.json({
      overrides,
      effective: effective === null ? ['ALL'] : Array.from(effective),
    });
  } catch (err) {
    console.error('Get user permissions error:', err);
    res.status(500).json({ error: 'Failed to load user permissions' });
  }
});

// PUT /api/permissions/users/:id — body: { permissionId, granted: true|false }
router.put('/users/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { permissionId, granted } = req.body || {};
    if (!permissionId || typeof granted !== 'boolean') {
      return res.status(400).json({ error: 'permissionId and a boolean granted are required' });
    }
    const userRows = await sql`SELECT id FROM users WHERE id = ${id}`;
    if (!userRows.length) return res.status(404).json({ error: 'User not found' });
    const permRows = await sql`SELECT id FROM permissions WHERE id = ${permissionId}`;
    if (!permRows.length) return res.status(404).json({ error: 'Permission not found' });

    const rows = await sql`
      INSERT INTO user_permissions (user_id, permission_id, granted, granted_by)
      VALUES (${id}, ${permissionId}, ${granted}, ${req.user.id})
      ON CONFLICT (user_id, permission_id) DO UPDATE SET
        granted = EXCLUDED.granted, granted_by = EXCLUDED.granted_by, granted_at = NOW()
      RETURNING *
    `;
    await audit.log(req, { action: 'set_permission', module: 'permissions', recordId: id, newValue: rows[0] });
    res.json(rows[0]);
  } catch (err) {
    console.error('Set user permission error:', err);
    res.status(500).json({ error: 'Failed to update permission' });
  }
});

// DELETE /api/permissions/users/:id/:permissionId — remove an override, falling back to role default
router.delete('/users/:id/:permissionId', requireAdmin, async (req, res) => {
  try {
    const { id, permissionId } = req.params;
    await sql`DELETE FROM user_permissions WHERE user_id = ${id} AND permission_id = ${permissionId}`;
    await audit.log(req, { action: 'clear_permission', module: 'permissions', recordId: id, oldValue: { permissionId } });
    res.json({ ok: true });
  } catch (err) {
    console.error('Clear user permission error:', err);
    res.status(500).json({ error: 'Failed to remove permission override' });
  }
});

module.exports = router;
