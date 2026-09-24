'use strict';
require('dotenv').config();

const express   = require('express');
const path      = require('path');
const helmet    = require('helmet');
const cors      = require('cors');
const rateLimit = require('express-rate-limit');
const { sql }   = require('./db');

const app  = express();
const PORT = process.env.PORT || 3000;

/* ── Security ──────────────────────────────────────────────────────────────── */
app.use(helmet({
  contentSecurityPolicy:      false,  // index.html uses inline scripts/styles
  crossOriginEmbedderPolicy:  false,
}));

/* ── CORS ──────────────────────────────────────────────────────────────────── */
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin))
      cb(null, true);
    else
      cb(new Error('CORS: origin not allowed — ' + origin));
  },
  credentials: true,
}));

/* ── Body parsing ──────────────────────────────────────────────────────────── */
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

/* ── Rate limiting ─────────────────────────────────────────────────────────── */
app.use('/api/auth/login', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many login attempts — please wait 15 minutes.' },
}));

app.use('/api/', rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  message: { error: 'Too many requests — slow down.' },
}));

/* ── API Routes ────────────────────────────────────────────────────────────── */
app.use('/api/auth',         require('./routes/auth.routes'));
app.use('/api/users',        require('./routes/users.routes'));
app.use('/api/employees',    require('./routes/employees.routes'));
app.use('/api/attendance',   require('./routes/attendance.routes'));
app.use('/api/invoices',     require('./routes/invoices.routes'));
app.use('/api/contact',      require('./routes/contact.routes'));
app.use('/api/site-content', require('./routes/siteContent.routes'));

/* ── Bootstrap ─────────────────────────────────────────────────────────────
   Called by loadHRMSData() after login.
   Must return: { employees, users, invoices, siteContent }
   ─────────────────────────────────────────────────────────────────────────── */
const { requireAuth } = require('./middleware/auth');

app.get('/api/bootstrap', requireAuth, async (req, res) => {
  try {
    const [employees, users, invoices, sc] = await Promise.all([
      sql`SELECT * FROM employees ORDER BY created_at DESC`,
      sql`SELECT id, name, role, active, created_at FROM users ORDER BY created_at DESC`,
      sql`SELECT * FROM invoices ORDER BY created_at DESC`,
      sql`SELECT value FROM site_content WHERE key = 'main'`,
    ]);
    res.json({
      employees,
      users,
      invoices,
      siteContent: sc[0] ? sc[0].value : {},
    });
  } catch (err) {
    console.error('Bootstrap error:', err);
    res.status(500).json({ error: 'Bootstrap failed' });
  }
});

/* ── Static files (public/) ────────────────────────────────────────────────── */
const publicDir = path.join(__dirname, '..', 'public');
app.use(express.static(publicDir, {
  maxAge: process.env.NODE_ENV === 'production' ? '1d' : 0,
  etag:   true,
}));

/* ── SPA catch-all ─────────────────────────────────────────────────────────── */
app.get('*', (req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

/* ── Global error handler ──────────────────────────────────────────────────── */
app.use((err, req, res, _next) => {
  console.error('Unhandled error:', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

/* ── Start ─────────────────────────────────────────────────────────────────── */
app.listen(PORT, () => {
  console.log(`🚀  LeoMox running → http://localhost:${PORT}`);
  console.log(`    NODE_ENV : ${process.env.NODE_ENV || 'development'}`);
  console.log(`    DB       : ${process.env.DATABASE_URL ? 'connected' : '⚠ DATABASE_URL not set'}`);
});
