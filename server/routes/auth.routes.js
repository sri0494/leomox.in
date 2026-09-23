// ============================================================================
// routes/auth.routes.js
// ============================================================================
const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { pool } = require('../db');
const { signToken, setSessionCookie, clearSessionCookie, requireAuth } = require('../middleware/auth');

const router = express.Router();

// Real, server-enforced rate limiting — 10 attempts per 15 minutes per IP.
// (This is the part that can't be done properly client-side, since a client
// can always just reload the page or clear storage to reset a client-only
// counter.)
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many login attempts. Please try again in 15 minutes.' }
});

router.post('/login', loginLimiter, async (req, res) => {
    const { id, password } = req.body || {};
    if (!id || !password) return res.status(400).json({ error: 'User ID and password are required.' });

    const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [String(id).trim()]);
    const user = rows[0];

    // Deliberately generic error message — do not reveal whether the ID
    // exists or the password was wrong, and never echo back default
    // credentials (a real issue that existed in an earlier client-only
    // version of this app).
    const genericError = () => res.status(401).json({ error: 'Invalid User ID or Password.' });

    if (!user) return genericError();
    if (!user.active) return res.status(403).json({ error: 'This account has been disabled. Contact an admin.' });

    if (user.locked_until && new Date(user.locked_until) > new Date()) {
        return res.status(403).json({ error: 'Account temporarily locked due to repeated failed attempts. Try again later.' });
    }

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
        const attempts = user.failed_attempts + 1;
        const lockUntil = attempts >= 5 ? new Date(Date.now() + 15 * 60 * 1000) : null;
        await pool.query(
            'UPDATE users SET failed_attempts = $1, locked_until = $2 WHERE id = $3',
            [attempts, lockUntil, user.id]
        );
        return genericError();
    }

    await pool.query('UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = $1', [user.id]);

    const token = signToken(user);
    setSessionCookie(res, token);
    res.json({ user: { id: user.id, name: user.name, role: user.role } });
});

router.post('/logout', (req, res) => {
    clearSessionCookie(res);
    res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => {
    res.json({ user: { id: req.user.id, name: req.user.name, role: req.user.role } });
});

// Change your own password while logged in (replaces the client-only
// "forgot password" flow, which couldn't actually verify identity without
// a backend anyway).
router.post('/change-password', requireAuth, async (req, res) => {
    const { currentPassword, newPassword } = req.body || {};
    if (!newPassword || newPassword.length < 6) {
        return res.status(400).json({ error: 'New password must be at least 6 characters.' });
    }
    const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
    const user = rows[0];
    if (!user) return res.status(404).json({ error: 'User not found.' });

    const ok = await bcrypt.compare(currentPassword || '', user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Current password is incorrect.' });

    const hash = await bcrypt.hash(newPassword, 12);
    await pool.query('UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2', [hash, user.id]);
    res.json({ ok: true });
});

module.exports = router;
