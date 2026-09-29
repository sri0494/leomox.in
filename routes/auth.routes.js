'use strict';
const express = require('express');
const jwt     = require('jsonwebtoken');
const bcrypt  = require('bcryptjs');
const { sql } = require('../db');
const { requireAuth } = require('../middleware/auth');
const audit   = require('../utils/audit');

const router = express.Router();
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '8h';

function signToken(user) {
  return jwt.sign(
    { id: user.id, name: user.name, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

function publicUser(u) {
  return { id: u.id, name: u.name, role: u.role, active: u.active };
}

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { id, password } = req.body || {};
    if (!id || !password) return res.status(400).json({ error: 'User ID and password are required' });

    const rows = await sql`SELECT * FROM users WHERE id = ${String(id).trim()}`;
    const user = rows[0];
    if (!user) return res.status(401).json({ error: 'Invalid user ID or password' });
    if (!user.active) return res.status(403).json({ error: 'This account has been disabled. Contact an administrator.' });

    const ok = await bcrypt.compare(String(password), user.password);
    if (!ok) return res.status(401).json({ error: 'Invalid user ID or password' });

    const token = signToken(user);
    await audit.log(req, { action: 'login', module: 'auth', recordId: user.id });
    res.json({ token, user: publicUser(user) });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// POST /api/auth/logout
// JWTs here are stateless (no server-side session store), so there is
// nothing to invalidate — the client just discards the token. This route
// exists so the client always has a clean, auditable logout call to make.
router.post('/logout', requireAuth, async (req, res) => {
  await audit.log(req, { action: 'logout', module: 'auth', recordId: req.user.id });
  res.json({ ok: true });
});

// GET /api/auth/me — used on page load to restore a session from a stored token
router.get('/me', requireAuth, async (req, res) => {
  try {
    const rows = await sql`SELECT id, name, role, active FROM users WHERE id = ${req.user.id}`;
    const user = rows[0];
    if (!user || !user.active) return res.status(401).json({ error: 'Session no longer valid' });
    res.json({ user });
  } catch (err) {
    console.error('Auth/me error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/auth/change-password — self-service, current-password required
router.post('/change-password', requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current and new password are required' });
    }
    if (String(newPassword).length < 6) {
      return res.status(400).json({ error: 'New password must be at least 6 characters' });
    }

    const rows = await sql`SELECT * FROM users WHERE id = ${req.user.id}`;
    const user = rows[0];
    if (!user) return res.status(404).json({ error: 'User not found' });

    const ok = await bcrypt.compare(String(currentPassword), user.password);
    if (!ok) return res.status(401).json({ error: 'Current password is incorrect' });

    const hash = await bcrypt.hash(String(newPassword), 12);
    await sql`UPDATE users SET password = ${hash} WHERE id = ${user.id}`;
    await audit.log(req, { action: 'change_password', module: 'auth', recordId: user.id });
    res.json({ ok: true });
  } catch (err) {
    console.error('Change password error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
