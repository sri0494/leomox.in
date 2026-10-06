'use strict';
require('dotenv').config();

const express   = require('express');
const path      = require('path');
const helmet    = require('helmet');
const cors      = require('cors');
const rateLimit = require('express-rate-limit');
const { sql }   = require('./db');
const hr        = require('./utils/hr');
const { employeeForUser } = require('./utils/employee');

const app  = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);
app.set('json replacer', hr.jsonReplacer); // DATE columns -> 'YYYY-MM-DD' (not ISO timestamps) // needed on Render/Railway so req.ip and rate-limit work behind their proxy

app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));

const allowedOrigins = (process.env.ALLOWED_ORIGINS||'').split(',').map(s=>s.trim()).filter(Boolean);
app.use(cors({
  origin: (origin, cb) => {
    if (!origin||allowedOrigins.length===0||allowedOrigins.includes(origin)) cb(null,true);
    else cb(new Error('CORS: origin not allowed'));
  },
  credentials: true
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

app.use('/api/auth/login', rateLimit({ windowMs:15*60*1000, max:10, message:{error:'Too many login attempts'} }));
app.use('/api/', rateLimit({ windowMs:60*1000, max:500, message:{error:'Too many requests'} }));

/* ── Health check (for Render) ── */
app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

/* ── Routes ── */
app.use('/api/auth',          require('./routes/auth.routes'));
app.use('/api/users',         require('./routes/users.routes'));
app.use('/api/employees',     require('./routes/employees.routes'));
app.use('/api/attendance',    require('./routes/attendance.routes'));
app.use('/api/payroll',       require('./routes/payroll.routes'));
app.use('/api/leave',         require('./routes/leave.routes'));
app.use('/api/invoices',      require('./routes/invoices.routes'));
app.use('/api/quotations',    require('./routes/quotations.routes'));
app.use('/api/company-settings', require('./routes/companySettings.routes'));
app.use('/api/contact',       require('./routes/contact.routes'));
app.use('/api/site-content',  require('./routes/siteContent.routes'));
app.use('/api/permissions',   require('./routes/permissions.routes'));
app.use('/api/audit',         require('./routes/audit.routes'));
app.use('/api/notifications', require('./routes/notifications.routes'));
app.use('/api/dashboard',     require('./routes/dashboard.routes'));

/* ── Bootstrap ── returns all data needed by the HRMS frontend on login ── */
const { requireAuth } = require('./middleware/auth');
const { getUserPermissions } = require('./middleware/permissions');

app.get('/api/bootstrap', requireAuth, async (req, res) => {
  try {
    // IMPORTANT: index.html's Dashboard tab is shown to *every* role
    // (including plain 'employee') and reads HRMS.employees / HRMS.invoices
    // directly for its company-wide stat cards — and bootstrap is the SPA's
    // *only* source for those arrays (there is no separate GET /employees
    // or /invoices call). So these three must stay company-wide for every
    // authenticated role, exactly as the original app relied on; role-based
    // field stripping only applies to the dedicated GET /api/employees API
    // (routes/employees.routes.js), which this SPA doesn't currently call.
    const [employees, users, invoices, sc, leaveTypes, notifications, me] = await Promise.all([
      sql`SELECT * FROM employees ORDER BY created_at DESC, id DESC`,
      sql`SELECT id, name, role, active, created_at FROM users ORDER BY created_at DESC`,
      sql`SELECT * FROM invoices ORDER BY created_at DESC, id DESC`,
      sql`SELECT value FROM site_content WHERE key = 'main'`,
      sql`SELECT * FROM leave_types WHERE active=TRUE ORDER BY id`.catch(() => []),
      sql`SELECT * FROM notifications WHERE user_id=${req.user.id} ORDER BY read ASC, created_at DESC LIMIT 15`.catch(() => []),
      employeeForUser(req.user.id),
    ]);

    const perms = await getUserPermissions(req.user.id, req.user.role);
    res.json({
      employees, users, invoices,
      siteContent: sc[0] ? sc[0].value : {},
      leaveTypes,
      notifications,
      me, // additive: the caller's own linked employee record, for future self-service screens
      permissions: perms === null ? ['ALL'] : Array.from(perms),
    });
  } catch (err) {
    console.error('Bootstrap error:', err);
    res.status(500).json({ error: 'Bootstrap failed' });
  }
});

/* ── Static + SPA ──
   server.js lives at the repo root, and the frontend lives in ./public
   alongside it — NOT one directory above (that path would point outside
   the repo entirely and 404 in any real deployment). */
const publicDir = path.join(__dirname, 'public');
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' })); // never fall through to index.html for API paths
app.use(express.static(publicDir, { maxAge: process.env.NODE_ENV==='production'?'1d':0, etag:true }));
app.get('*', (req, res) => res.sendFile(path.join(publicDir, 'index.html')));
app.use((err, req, res, _next) => {
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed JSON body' });
  console.error(err.message);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`🚀 LeoMox HRMS → http://localhost:${PORT}  (${process.env.NODE_ENV||'development'})`);
});
