// ============================================================================
// routes/siteContent.routes.js — public homepage copy, editable by admins.
// ============================================================================
const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

// Public — the homepage needs this without being logged in.
router.get('/', async (req, res) => {
    const { rows } = await pool.query('SELECT key, value FROM site_content');
    const content = {};
    rows.forEach(r => { content[r.key] = r.value; });
    res.json(content);
});

router.put('/', requireAuth, requireRole('admin', 'manager'), async (req, res) => {
    const updates = req.body || {};
    const keys = Object.keys(updates);
    if (keys.length === 0) return res.status(400).json({ error: 'No fields provided.' });

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        for (const key of keys) {
            await client.query(
                `INSERT INTO site_content (key, value) VALUES ($1,$2)
                 ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
                [key, String(updates[key] ?? '')]
            );
        }
        await client.query('COMMIT');
    } catch (e) {
        await client.query('ROLLBACK');
        throw e;
    } finally {
        client.release();
    }

    const { rows } = await pool.query('SELECT key, value FROM site_content');
    const content = {};
    rows.forEach(r => { content[r.key] = r.value; });
    res.json(content);
});

module.exports = router;
