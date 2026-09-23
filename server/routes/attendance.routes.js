// ============================================================================
// routes/attendance.routes.js
// ============================================================================
const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

// Today's attendance, joined with employee names — used by the dashboard.
router.get('/', requireAuth, async (req, res) => {
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    const { rows } = await pool.query(
        `SELECT e.id AS employee_id, e.name, e.dept, COALESCE(a.status, 'Not Marked') AS status
         FROM employees e
         LEFT JOIN attendance a ON a.employee_id = e.id AND a.date = $1
         ORDER BY e.name`,
        [date]
    );
    res.json({ date, records: rows });
});

router.post('/mark', requireAuth, requireRole('admin', 'manager', 'hr'), async (req, res) => {
    const { employeeId, date, status } = req.body || {};
    if (!employeeId || !status) return res.status(400).json({ error: 'employeeId and status are required.' });
    const d = date || new Date().toISOString().slice(0, 10);

    await pool.query(
        `INSERT INTO attendance (employee_id, date, status)
         VALUES ($1,$2,$3)
         ON CONFLICT (employee_id, date) DO UPDATE SET status = EXCLUDED.status`,
        [employeeId, d, status]
    );
    res.json({ ok: true });
});

module.exports = router;
