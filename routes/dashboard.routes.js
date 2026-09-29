'use strict';
const express = require('express');
const { sql } = require('../db');
const { requireAuth } = require('../middleware/auth');
const hr = require('../utils/hr');
const { employeeForUser } = require('../utils/employee');

const router = express.Router();
const INACTIVE = ['Inactive', 'Resigned', 'Terminated', 'Relieved'];

// GET /api/dashboard — role-aware summary widgets
router.get('/', requireAuth, async (req, res) => {
  try {
    const role = req.user.role;
    const staff = ['admin', 'manager', 'hr'].includes(role);
    const today = hr.todayStr();
    const out = { today, role };

    const emps = await sql`SELECT id, name, dept, dob, joined, status FROM employees`;
    const active = emps.filter((e) => !INACTIVE.includes(e.status));

    // Names + dates only (safe for every role)
    out.birthdays = active
      .map((e) => ({ name: e.name, dept: e.dept, daysAway: hr.daysUntilAnniversary(e.dob, today), date: hr.toDateStr(e.dob) }))
      .filter((b) => b.daysAway !== null && b.daysAway <= 30)
      .sort((a, b) => a.daysAway - b.daysAway)
      .slice(0, 8);
    const since = hr.addDays(today, -30);
    out.newJoiners = active
      .filter((e) => { const j = hr.toDateStr(e.joined); return j && j >= since && j <= today; })
      .map((e) => ({ name: e.name, dept: e.dept, joined: hr.toDateStr(e.joined) }))
      .slice(0, 8);

    if (staff) {
      const byDept = {};
      for (const e of active) { const k = e.dept || 'Unassigned'; byDept[k] = (byDept[k] || 0) + 1; }
      out.departments = Object.entries(byDept).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);

      const att = await sql`SELECT status, COUNT(*)::int AS c FROM attendance WHERE date = ${today} GROUP BY status`;
      const counts = {}; let marked = 0;
      for (const r of att) { counts[r.status] = r.c; marked += r.c; }
      out.attendanceToday = { counts, marked, active: active.length, notMarked: Math.max(active.length - marked, 0) };

      const pend = role === 'manager'
        ? await sql`SELECT COUNT(*)::int AS c FROM leave_requests WHERE status = 'Submitted'`
        : await sql`SELECT COUNT(*)::int AS c FROM leave_requests WHERE status IN ('Submitted','Manager Approved')`;
      out.pendingLeaves = pend[0].c;

      out.onLeaveToday = await sql`
        SELECT e.name, lt.name AS leave_type FROM leave_requests lr
        JOIN employees e ON e.id = lr.employee_id JOIN leave_types lt ON lt.id = lr.leave_type_id
        WHERE lr.status = 'HR Approved' AND ${today} BETWEEN lr.from_date AND lr.to_date ORDER BY e.name LIMIT 10`;
    }

    const me = await employeeForUser(req.user.id);
    if (me) {
      const year = Number(today.slice(0, 4));
      const rec = await sql`SELECT status, check_in, check_out FROM attendance WHERE employee_id = ${me.id} AND date = ${today}`;
      let bal = await sql`
        SELECT lb.leave_type_id, lt.name AS leave_type_name, lt.paid, lb.accrued, lb.used, lb.pending, lb.closing
        FROM leave_balances lb JOIN leave_types lt ON lt.id = lb.leave_type_id
        WHERE lb.employee_id = ${me.id} AND lb.year = ${year} AND lt.active = TRUE AND lt.annual_days > 0 ORDER BY lt.id`;
      if (!bal.length) {
        bal = await sql`SELECT id AS leave_type_id, name AS leave_type_name, paid, annual_days AS accrued, 0 AS used, 0 AS pending, annual_days AS closing
                        FROM leave_types WHERE active = TRUE AND annual_days > 0 ORDER BY id`;
      }
      const myPend = await sql`SELECT COUNT(*)::int AS c FROM leave_requests WHERE employee_id = ${me.id} AND status IN ('Submitted','Manager Approved')`;
      out.me = { id: me.id, name: me.name, work_mode: me.work_mode, today: rec[0] || null, balances: bal, pendingRequests: myPend[0].c };
    }
    res.json(out);
  } catch (err) {
    console.error('Dashboard error:', err);
    res.status(500).json({ error: 'Failed to load dashboard' });
  }
});

module.exports = router;
