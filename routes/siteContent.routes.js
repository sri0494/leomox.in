'use strict';
const express = require('express');
const { sql } = require('../db');
const { requireAdmin } = require('../middleware/auth');
const audit   = require('../utils/audit');

const router = express.Router();

// GET /api/site-content — PUBLIC. Loaded on every visitor's page load so
// everyone sees the latest admin-edited hero text, contact info, etc.
router.get('/', async (req, res) => {
  try {
    const rows = await sql`SELECT value FROM site_content WHERE key = 'main'`;
    res.json(rows[0] ? rows[0].value : {});
  } catch (err) {
    console.error('Get site content error:', err);
    res.status(500).json({ error: 'Failed to load site content' });
  }
});

// PUT /api/site-content — only admin has the "website" module (Website tab)
router.put('/', requireAdmin, async (req, res) => {
  try {
    const value = req.body || {};
    const rows = await sql`
      INSERT INTO site_content (key, value, updated_at)
      VALUES ('main', ${JSON.stringify(value)}::jsonb, NOW())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
      RETURNING value
    `;
    await audit.log(req, { action: 'update', module: 'site_content', recordId: 'main', newValue: value });
    res.json(rows[0].value);
  } catch (err) {
    console.error('Update site content error:', err);
    res.status(500).json({ error: 'Failed to save site content' });
  }
});

module.exports = router;
