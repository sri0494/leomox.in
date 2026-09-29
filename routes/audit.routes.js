'use strict';
const express = require('express');
const { sql } = require('../db');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();

// GET /api/audit?module=employees&limit=50&offset=0
router.get('/', requireAdmin, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const offset = Number(req.query.offset) || 0;
    const { module: mod } = req.query;

    const rows = mod
      ? await sql`SELECT * FROM audit_logs WHERE module = ${mod} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`
      : await sql`SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`;

    res.json(rows);
  } catch (err) {
    console.error('List audit logs error:', err);
    res.status(500).json({ error: 'Failed to load audit logs' });
  }
});

module.exports = router;
