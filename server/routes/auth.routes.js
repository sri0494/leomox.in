'use strict';
const express = require('express');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const { sql } = require('../db');
const { requireAuth } = require('../middleware/auth');
const router  = express.Router();

function makeToken(user) {
  return jwt.sign(
    { id: user.id, name: user.name, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: '8h' }
  );
}

/* POST /api/auth/login */
router.post('/login', async (req, res) => {
  try {
    const { id, password } = req.body;
    if (!id || !password) return res.status(400).json({ error: 'ID and password required' });

    const [user] = await sql`SELECT * FROM users WHERE id = ${id} AND active = TRUE`;
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

    const token = makeToken(user);
    res.json({ token, user: { id: user.id, name: user.name, role: user.role } });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/* GET /api/auth/me */
router.get('/me', requireAuth, async (req, res) => {
  try {
    const [user] = await sql`SELECT id, name, role, active FROM users WHERE id = ${req.user.id}`;
    if (!user || !user.active) return res.status(401).json({ error: 'User not found or inactive' });
    res.json({ id: user.id, name: user.name, role: user.role });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/* POST /api/auth/logout  (client-side token drop; server just acknowledges) */
router.post('/logout', (req, res) => res.json({ ok: true }));

/* POST /api/auth/change-password */
router.post('/change-password', requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Both passwords required' });
    if (newPassword.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' });

    const [user] = await sql`SELECT * FROM users WHERE id = ${req.user.id}`;
    if (!user) return res.status(404).json({ error: 'User not found' });

    const ok = await bcrypt.compare(currentPassword, user.password);
    if (!ok) return res.status(401).json({ error: 'Current password incorrect' });

    const hashed = await bcrypt.hash(newPassword, 12);
    await sql`UPDATE users SET password = ${hashed} WHERE id = ${req.user.id}`;
    res.json({ ok: true });
  } catch (err) {
    console.error('Change-password error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
