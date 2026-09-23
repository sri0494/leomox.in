'use strict';
const express  = require('express');
const { sql }  = require('../db');
const { requireAdmin } = require('../middleware/auth');
const router   = express.Router();

const CONTENT_KEY = 'main';

/* GET /api/site-content — public, used on page load */
router.get('/', async (req, res) => {
  try {
    const [row] = await sql`SELECT value FROM site_content WHERE key = ${CONTENT_KEY}`;
    res.json(row ? row.value : {});
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

/* PUT /api/site-content — admin only */
router.put('/', requireAdmin, async (req, res) => {
  try {
    const content = req.body;
    const [row] = await sql`
      INSERT INTO site_content (key, value, updated_at)
      VALUES (${CONTENT_KEY}, ${JSON.stringify(content)}, NOW())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
      RETURNING value
    `;
    res.json(row.value);
  } catch (err) {
    console.error('Site content save error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
