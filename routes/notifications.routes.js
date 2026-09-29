'use strict';
const express = require('express');
const { sql } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

function parseId(raw) {
  const n = Number(raw);
  return Number.isInteger(n) ? n : null;
}

// GET /api/notifications — the caller's own notifications (unread-only via /api/bootstrap;
// this endpoint additionally supports viewing everything with ?all=1)
router.get('/', requireAuth, async (req, res) => {
  try {
    const rows = req.query.all
      ? await sql`SELECT * FROM notifications WHERE user_id = ${req.user.id} ORDER BY created_at DESC LIMIT 100`
      : await sql`SELECT * FROM notifications WHERE user_id = ${req.user.id} AND read = FALSE ORDER BY created_at DESC LIMIT 50`;
    res.json(rows);
  } catch (err) {
    console.error('List notifications error:', err);
    res.status(500).json({ error: 'Failed to load notifications' });
  }
});

// PUT /api/notifications/:id/read
router.put('/:id/read', requireAuth, async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Invalid notification id' });
    const rows = await sql`
      UPDATE notifications SET read = TRUE WHERE id = ${id} AND user_id = ${req.user.id}
      RETURNING *
    `;
    if (!rows.length) return res.status(404).json({ error: 'Notification not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('Mark notification read error:', err);
    res.status(500).json({ error: 'Failed to update notification' });
  }
});

// PUT /api/notifications/read-all
router.put('/read-all', requireAuth, async (req, res) => {
  try {
    await sql`UPDATE notifications SET read = TRUE WHERE user_id = ${req.user.id} AND read = FALSE`;
    res.json({ ok: true });
  } catch (err) {
    console.error('Mark all notifications read error:', err);
    res.status(500).json({ error: 'Failed to update notifications' });
  }
});

module.exports = router;
