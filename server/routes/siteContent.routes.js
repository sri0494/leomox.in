'use strict';
const express = require('express');
const { sql } = require('../db');
const { requireAdmin } = require('../middleware/auth');
const router  = express.Router();

const KEY = 'main';

/* GET /api/site-content — PUBLIC: fetched on page load */
router.get('/', async (req, res) => {
  try {
    const [row] = await sql`SELECT value FROM site_content WHERE key = ${KEY}`;
    res.json(row ? row.value : {});
  } catch (err) {
    console.error('site-content GET error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/* PUT /api/site-content — ADMIN only */
router.put('/', requireAdmin, async (req, res) => {
  try {
    const content = req.body;
    const [row] = await sql`
      INSERT INTO site_content (key, value, updated_at)
      VALUES (${KEY}, ${JSON.stringify(content)}, NOW())
      ON CONFLICT (key)
        DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
      RETURNING value
    `;
    res.json(row.value);
  } catch (err) {
    console.error('site-content PUT error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
