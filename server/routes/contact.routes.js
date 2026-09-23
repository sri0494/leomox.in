// ============================================================================
// routes/contact.routes.js — public contact-form submissions + admin inbox.
// ============================================================================
const express = require('express');
const rateLimit = require('express-rate-limit');
const { pool } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

// Public form is open to the internet — rate-limit it to deter spam/abuse.
const submitLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many submissions from this network. Please try again later.' }
});

router.post('/', submitLimiter, async (req, res) => {
    const { name, mobile, email, service, company, message } = req.body || {};
    if (!name || !mobile) return res.status(400).json({ error: 'Name and mobile number are required.' });
    if (String(mobile).replace(/\D/g, '').length < 10) return res.status(400).json({ error: 'Please enter a valid mobile number.' });
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });

    const { rows } = await pool.query(
        `INSERT INTO contact_requests (name, mobile, email, service, company, message)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, created_at`,
        [name, mobile, email || '', service || '', company || '', message || '']
    );
    res.status(201).json({ ok: true, id: rows[0].id });
});

// Admin inbox of submitted leads
router.get('/', requireAuth, requireRole('admin', 'manager', 'hr'), async (req, res) => {
    const { rows } = await pool.query('SELECT * FROM contact_requests ORDER BY created_at DESC LIMIT 500');
    res.json(rows);
});

router.put('/:id/status', requireAuth, requireRole('admin', 'manager', 'hr'), async (req, res) => {
    const { status } = req.body || {};
    if (!['New', 'Contacted', 'Closed'].includes(status)) return res.status(400).json({ error: 'Invalid status.' });
    await pool.query('UPDATE contact_requests SET status=$1 WHERE id=$2', [status, req.params.id]);
    res.json({ ok: true });
});

module.exports = router;
