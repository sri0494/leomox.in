'use strict';
require('dotenv').config();

const express     = require('express');
const path        = require('path');
const helmet      = require('helmet');
const cors        = require('cors');
const rateLimit   = require('express-rate-limit');
const bcrypt      = require('bcryptjs');
const { sql, bootstrap } = require('./db');

const app  = express();
const PORT = process.env.PORT || 3000;

/* ── Security headers ─────────────────────────────────────────── */
app.use(helmet({
  contentSecurityPolicy: false,   // index.html uses inline scripts/styles
  crossOriginEmbedderPolicy: false
}));

/* ── CORS ─────────────────────────────────────────────────────── */
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map(o => o.trim()).filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    // Allow same-origin requests (origin is undefined for direct server calls)
    if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
      cb(null, true);
    } else {
      cb(new Error('CORS: origin not allowed — ' + origin));
    }
  },
  credentials: true
}));

/* ── Body parsing ─────────────────────────────────────────────── */
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

/* ── Rate limiting ────────────────────────────────────────────── */
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 minutes
  max: 20,
  message: { error: 'Too many login attempts — please wait 15 minutes.' }
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,        // 1 minute
  max: 200,
  message: { error: 'Too many requests — please slow down.' }
});

app.use('/api/auth/login', loginLimiter);
app.use('/api/', apiLimiter);

/* ── API Routes ───────────────────────────────────────────────── */
app.use('/api/auth',         require('./routes/auth'));
app.use('/api/users',        require('./routes/users'));
app.use('/api/employees',    require('./routes/employees'));
app.use('/api/attendance',   require('./routes/attendance'));
app.use('/api/invoices',     require('./routes/invoices'));
app.use('/api/contact',      require('./routes/contact'));
app.use('/api/site-content', require('./routes/siteContent'));

/* ── Bootstrap endpoint (called from index.html on page load) ─── */
app.get('/api/bootstrap', async (req, res) => {
  try {
    // Load site content (public, no auth needed)
    const [sc] = await sql`SELECT value FROM site_content WHERE key = 'main'`;
    res.json({ siteContent: sc ? sc.value : {} });
  } catch (err) {
    console.error('Bootstrap error:', err);
    res.status(500).json({ error: 'Bootstrap failed' });
  }
});

/* ── Static files ─────────────────────────────────────────────── */
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: process.env.NODE_ENV === 'production' ? '1d' : 0,
  etag:   true
}));

/* ── SPA catch-all (serve index.html for any unknown route) ───── */
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/* ── Global error handler ─────────────────────────────────────── */
app.use((err, req, res, _next) => {
  console.error('Unhandled error:', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

/* ── Seed default admin if no users exist ─────────────────────── */
async function seedAdmin() {
  const [count] = await sql`SELECT COUNT(*) FROM users`;
  if (parseInt(count.count) === 0) {
    const id       = process.env.SEED_ADMIN_ID       || 'admin';
    const password = process.env.SEED_ADMIN_PASSWORD || 'leomox@2024';
    const name     = process.env.SEED_ADMIN_NAME     || 'LeoMox Admin';
    const hashed   = await bcrypt.hash(password, 12);
    await sql`INSERT INTO users (id, name, password, role) VALUES (${id}, ${name}, ${hashed}, 'admin')`;
    console.log(`✅ Default admin created — ID: ${id}  (change password after first login!)`);
  }
}

/* ── Start ────────────────────────────────────────────────────── */
async function start() {
  try {
    await bootstrap();   // Create tables
    await seedAdmin();   // Seed admin if first run
    app.listen(PORT, () => {
      console.log(`🚀 LeoMox website running on http://localhost:${PORT}`);
      console.log(`   NODE_ENV: ${process.env.NODE_ENV || 'development'}`);
    });
  } catch (err) {
    console.error('❌ Failed to start server:', err);
    process.exit(1);
  }
}

start();
