// ============================================================================
// server.js — LeoMox IT Solutions backend (Express + Neon Postgres)
// ============================================================================
require('dotenv').config();
require('express-async-errors'); // patches Express so rejected promises in async route handlers reach the error middleware below instead of crashing the process
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const { attachUser } = require('./middleware/auth');
const authRoutes = require('./routes/auth.routes');
const employeesRoutes = require('./routes/employees.routes');
const usersRoutes = require('./routes/users.routes');
const attendanceRoutes = require('./routes/attendance.routes');
const invoicesRoutes = require('./routes/invoices.routes');
const siteContentRoutes = require('./routes/siteContent.routes');
const contactRoutes = require('./routes/contact.routes');
const bootstrapRoutes = require('./routes/bootstrap.routes');

const app = express();
const PORT = process.env.PORT || 3000;
const isProd = process.env.NODE_ENV === 'production';

app.set('trust proxy', 1); // needed for correct req.ip behind Render/Railway/etc. proxies

app.use(helmet({
    contentSecurityPolicy: false // the frontend inlines <script>/<style>; enable & tune this once you split assets out
}));
app.use(cors({
    origin: process.env.CORS_ORIGIN || true,
    credentials: true
}));
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use(attachUser);

// Generic API rate limit as a baseline, on top of the stricter per-route
// limits already applied to /auth/login and /contact.
app.use('/api', rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false
}));

app.use('/api/auth', authRoutes);
app.use('/api/employees', employeesRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/attendance', attendanceRoutes);
app.use('/api/invoices', invoicesRoutes);
app.use('/api/site-content', siteContentRoutes);
app.use('/api/contact', contactRoutes);
app.use('/api/bootstrap', bootstrapRoutes);

app.get('/api/health', (req, res) => res.json({ ok: true, env: isProd ? 'production' : 'development' }));

// Static frontend
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// Central error handler — never leak stack traces to the client.
app.use((err, req, res, next) => {
    console.error(err);
    res.status(err.status || 500).json({ error: isProd ? 'Something went wrong.' : err.message });
});

app.listen(PORT, () => {
    console.log(`LeoMox server listening on port ${PORT} (${isProd ? 'production' : 'development'})`);
});
