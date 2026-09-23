// ============================================================================
// routes/users.routes.js — HRMS login-account management. Admin only.
// ============================================================================
const express = require('express');
const bcrypt = require('bcryptjs');
const { pool } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
const ID_PATTERN = /^[a-zA-Z0-9_-]{2,32}$/;

router.get('/', requireAuth, requireRole('admin'), async (req, res) => {
    const { rows } = await pool.query(
        'SELECT id, name, role, active, created_at FROM users ORDER BY created_at'
    );
    res.json(rows); // password_hash intentionally never returned to the client
});

router.post('/', requireAuth, requireRole('admin'), async (req, res) => {
    const { id, name, password, role } = req.body || {};
    if (!id || !name || !password) return res.status(400).json({ error: 'User ID, name and password are required.' });
    if (!ID_PATTERN.test(id)) return res.status(400).json({ error: 'User ID may only contain letters, numbers, hyphens and underscores (2-32 characters).' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    if (!['admin', 'manager', 'hr', 'employee'].includes(role)) return res.status(400).json({ error: 'Invalid role.' });

    const { rows: dupe } = await pool.query('SELECT id FROM users WHERE id = $1', [id]);
    if (dupe[0]) return res.status(409).json({ error: 'User ID already exists.' });

    const hash = await bcrypt.hash(password, 12);
    const { rows } = await pool.query(
        `INSERT INTO users (id, name, password_hash, role, active)
         VALUES ($1,$2,$3,$4,true) RETURNING id, name, role, active, created_at`,
        [id, name, hash, role]
    );
    res.status(201).json(rows[0]);
});

router.put('/:id', requireAuth, requireRole('admin'), async (req, res) => {
    const { name, role, password } = req.body || {};
    if (password && password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });

    if (password) {
        const hash = await bcrypt.hash(password, 12);
        await pool.query('UPDATE users SET name=$1, role=$2, password_hash=$3, updated_at=now() WHERE id=$4',
            [name, role, hash, req.params.id]);
    } else {
        await pool.query('UPDATE users SET name=$1, role=$2, updated_at=now() WHERE id=$3',
            [name, role, req.params.id]);
    }
    const { rows } = await pool.query('SELECT id, name, role, active, created_at FROM users WHERE id=$1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'User not found.' });
    res.json(rows[0]);
});

router.post('/:id/toggle-active', requireAuth, requireRole('admin'), async (req, res) => {
    if (req.params.id === 'admin') return res.status(400).json({ error: 'The primary admin account cannot be disabled.' });
    const { rows } = await pool.query(
        'UPDATE users SET active = NOT active, updated_at = now() WHERE id = $1 RETURNING id, name, role, active',
        [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'User not found.' });
    res.json(rows[0]);
});

router.delete('/:id', requireAuth, requireRole('admin'), async (req, res) => {
    if (req.params.id === 'admin') return res.status(400).json({ error: 'The primary admin account cannot be deleted.' });
    await pool.query('DELETE FROM users WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
});

module.exports = router;
