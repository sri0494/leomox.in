'use strict';
const express = require('express');
const { sql } = require('../db');
const { requireAuth, requireHR } = require('../middleware/auth');
const audit = require('../utils/audit');
const hr = require('../utils/hr');
const { employeeForUser, scopeEmployeeId, parseIntId } = require('../utils/employee');

const router = express.Router();
const STATUSES = ['Present', 'Absent', 'Half Day', 'Leave', 'Holiday', 'Weekly Off', 'Work From Home', 'On Duty'];
const NO_TIME = ['Absent', 'Leave', 'Holiday', 'Weekly Off']; // these days carry no punch times

/* ── helpers ──────────────────────────────────────────────────────────── */

// Validate one attendance entry. `undefined` fields mean "leave as-is on update".
function cleanEntry(e) {
  const x = e || {};
  const empId = parseIntId(x.employeeId);
  if (!empId) return { error: 'Invalid employee id' };
  let status = 'Present';
  if (x.status !== undefined && x.status !== null && x.status !== '') {
    if (!STATUSES.includes(x.status)) return { error: `Invalid status "${x.status}"` };
    status = x.status;
  }
  const time = (v) => (v === undefined ? undefined : v === null || v === '' ? null : String(v).trim());
  let checkIn = time(x.checkIn), checkOut = time(x.checkOut);
  for (const [label, v] of [['Check-in', checkIn], ['Check-out', checkOut]]) {
    if (v && !hr.isValidTime(v)) return { error: `${label} time must be HH:MM` };
  }
  if (NO_TIME.includes(status)) { checkIn = null; checkOut = null; }
  if (checkIn && checkOut && checkOut.slice(0, 5) <= checkIn.slice(0, 5)) {
    return { error: 'Check-out must be later than check-in' };
  }
  const remarks = x.remarks === undefined ? undefined : (String(x.remarks || '').trim().slice(0, 200) || null);
  return {
    empId, status, checkIn, checkOut, remarks,
    keepIn: checkIn === undefined, keepOut: checkOut === undefined, keepRemarks: remarks === undefined,
  };
}

function checkMarkableDate(date) {
  if (!hr.isValidDate(date)) return 'date must be YYYY-MM-DD';
  if (date > hr.todayStr()) return 'Cannot mark attendance for a future date';
  return null;
}

async function upsert(entry, date, markedBy) {
  const rows = await sql`
    INSERT INTO attendance (employee_id, date, status, marked_by, check_in, check_out, remarks)
    VALUES (${entry.empId}, ${date}, ${entry.status}, ${markedBy}, ${entry.checkIn ?? null}, ${entry.checkOut ?? null}, ${entry.remarks ?? null})
    ON CONFLICT (employee_id, date) DO UPDATE SET
      status    = EXCLUDED.status,
      marked_by = EXCLUDED.marked_by,
      check_in  = CASE WHEN ${entry.keepIn}      THEN attendance.check_in  ELSE EXCLUDED.check_in  END,
      check_out = CASE WHEN ${entry.keepOut}     THEN attendance.check_out ELSE EXCLUDED.check_out END,
      remarks   = CASE WHEN ${entry.keepRemarks} THEN attendance.remarks   ELSE EXCLUDED.remarks   END
    RETURNING *`;
  return rows[0];
}

// Employee ids whose payroll for that month is locked (attendance frozen).
async function lockedSet(date) {
  const y = Number(date.slice(0, 4)), m = Number(date.slice(5, 7));
  const rows = await sql`SELECT employee_id FROM payroll WHERE month = ${m} AND year = ${y} AND status = 'Locked'`;
  return new Set(rows.map((r) => r.employee_id));
}

function monthParams(q) {
  const today = hr.todayStr();
  const month = q.month === undefined ? Number(today.slice(5, 7)) : Number(q.month);
  const year = q.year === undefined ? Number(today.slice(0, 4)) : Number(q.year);
  if (!Number.isInteger(month) || month < 1 || month > 12 || !Number.isInteger(year) || year < 2000 || year > 2100) return null;
  return { month, year, ...hr.monthRange(year, month) };
}

/* ── reads ────────────────────────────────────────────────────────────── */

// GET /api/attendance?date=YYYY-MM-DD — everyone's rows for a day (staff)
router.get('/', requireHR, async (req, res) => {
  try {
    const date = req.query.date || hr.todayStr();
    if (!hr.isValidDate(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    const rows = await sql`SELECT * FROM attendance WHERE date = ${date} ORDER BY employee_id`;
    res.json(rows);
  } catch (err) {
    console.error('List attendance error:', err);
    res.status(500).json({ error: 'Failed to load attendance' });
  }
});

// GET /api/attendance/me/today — own record for today + the linked employee
router.get('/me/today', requireAuth, async (req, res) => {
  try {
    const emp = await employeeForUser(req.user.id);
    if (!emp) return res.json({ employee: null, date: hr.todayStr(), record: null });
    const date = hr.todayStr();
    const rows = await sql`SELECT * FROM attendance WHERE employee_id = ${emp.id} AND date = ${date}`;
    res.json({ employee: { id: emp.id, name: emp.name, work_mode: emp.work_mode }, date, record: rows[0] || null });
  } catch (err) {
    console.error('Today attendance error:', err);
    res.status(500).json({ error: 'Failed to load today\'s attendance' });
  }
});

// GET /api/attendance/summary?month=9&year=2026 — per-employee counts
router.get('/summary', requireAuth, async (req, res) => {
  try {
    const mp = monthParams(req.query);
    if (!mp) return res.status(400).json({ error: 'Invalid month/year' });
    const scope = await scopeEmployeeId(req, null);
    if (scope.error) return res.status(scope.status).json({ error: scope.error });

    const rows = scope.id
      ? await sql`SELECT employee_id,
          COUNT(*) FILTER (WHERE status='Present')::int AS present, COUNT(*) FILTER (WHERE status='Absent')::int AS absent,
          COUNT(*) FILTER (WHERE status='Half Day')::int AS half_day, COUNT(*) FILTER (WHERE status='Leave')::int AS leave,
          COUNT(*) FILTER (WHERE status='Work From Home')::int AS wfh, COUNT(*) FILTER (WHERE status='On Duty')::int AS on_duty,
          COUNT(*) FILTER (WHERE status='Holiday')::int AS holiday, COUNT(*) FILTER (WHERE status='Weekly Off')::int AS weekly_off
        FROM attendance WHERE date BETWEEN ${mp.start} AND ${mp.end} AND employee_id = ${scope.id} GROUP BY employee_id`
      : await sql`SELECT employee_id,
          COUNT(*) FILTER (WHERE status='Present')::int AS present, COUNT(*) FILTER (WHERE status='Absent')::int AS absent,
          COUNT(*) FILTER (WHERE status='Half Day')::int AS half_day, COUNT(*) FILTER (WHERE status='Leave')::int AS leave,
          COUNT(*) FILTER (WHERE status='Work From Home')::int AS wfh, COUNT(*) FILTER (WHERE status='On Duty')::int AS on_duty,
          COUNT(*) FILTER (WHERE status='Holiday')::int AS holiday, COUNT(*) FILTER (WHERE status='Weekly Off')::int AS weekly_off
        FROM attendance WHERE date BETWEEN ${mp.start} AND ${mp.end} GROUP BY employee_id`;
    res.json(rows.map((r) => ({ ...r, lop_days: r.absent + 0.5 * r.half_day })));
  } catch (err) {
    console.error('Attendance summary error:', err);
    res.status(500).json({ error: 'Failed to load attendance summary' });
  }
});

// GET /api/attendance/employee/:id?month=&year= — day-by-day for one employee
router.get('/employee/:id', requireAuth, async (req, res) => {
  try {
    const mp = monthParams(req.query);
    if (!mp) return res.status(400).json({ error: 'Invalid month/year' });
    const scope = await scopeEmployeeId(req, req.params.id);
    if (scope.error) return res.status(scope.status).json({ error: scope.error });
    if (!parseIntId(scope.id)) return res.status(400).json({ error: 'Invalid employee id' });
    const rows = await sql`SELECT * FROM attendance WHERE employee_id = ${scope.id} AND date BETWEEN ${mp.start} AND ${mp.end} ORDER BY date`;
    res.json(rows);
  } catch (err) {
    console.error('Employee attendance error:', err);
    res.status(500).json({ error: 'Failed to load attendance' });
  }
});

/* ── writes ───────────────────────────────────────────────────────────── */

// POST /api/attendance/mark — one employee (admin / manager / hr)
router.post('/mark', requireHR, async (req, res) => {
  try {
    const { date } = req.body || {};
    const dErr = checkMarkableDate(date);
    if (dErr) return res.status(400).json({ error: dErr });
    const entry = cleanEntry(req.body);
    if (entry.error) return res.status(400).json({ error: entry.error });
    if ((await lockedSet(date)).has(entry.empId)) {
      return res.status(409).json({ error: 'Payroll for this month is locked; attendance can no longer be changed' });
    }
    const row = await upsert(entry, date, req.user.id);
    await audit.log(req, { action: 'mark', module: 'attendance', recordId: row.id, newValue: { employee_id: entry.empId, date, status: entry.status } });
    res.json(row);
  } catch (err) {
    if (err && err.code === '23503') return res.status(404).json({ error: 'Employee not found' });
    console.error('Mark attendance error:', err);
    res.status(500).json({ error: 'Failed to save attendance' });
  }
});

// POST /api/attendance/bulk — { date, entries:[{employeeId,status,checkIn,checkOut,remarks}] }
router.post('/bulk', requireHR, async (req, res) => {
  try {
    const { date, entries } = req.body || {};
    const dErr = checkMarkableDate(date);
    if (dErr) return res.status(400).json({ error: dErr });
    if (!Array.isArray(entries) || !entries.length) return res.status(400).json({ error: 'entries must be a non-empty array' });
    if (entries.length > 500) return res.status(400).json({ error: 'Too many entries (max 500 per request)' });

    const cleaned = [];
    for (const e of entries) {
      const c = cleanEntry(e);
      if (c.error) return res.status(400).json({ error: `Employee ${e && e.employeeId}: ${c.error}` });
      cleaned.push(c);
    }
    const locked = await lockedSet(date);
    const skipped = [];
    let saved = 0;
    for (const c of cleaned) {
      if (locked.has(c.empId)) { skipped.push({ employeeId: c.empId, reason: 'Payroll locked' }); continue; }
      try { await upsert(c, date, req.user.id); saved++; }
      catch (err) { skipped.push({ employeeId: c.empId, reason: err && err.code === '23503' ? 'Employee not found' : 'Save failed' }); }
    }
    await audit.log(req, { action: 'bulk_mark', module: 'attendance', recordId: date, newValue: { saved, skipped: skipped.length } });
    res.json({ saved, skipped });
  } catch (err) {
    console.error('Bulk attendance error:', err);
    res.status(500).json({ error: 'Failed to save attendance' });
  }
});

// POST /api/attendance/check-in — self-service punch-in (any role with a linked employee)
router.post('/check-in', requireAuth, async (req, res) => {
  try {
    const emp = await employeeForUser(req.user.id);
    if (!emp) return res.status(404).json({ error: 'No employee record is linked to your login. Please ask HR to link it.' });
    const date = hr.todayStr(), time = hr.nowTimeStr();
    const ex = (await sql`SELECT * FROM attendance WHERE employee_id = ${emp.id} AND date = ${date}`)[0];
    if (ex && ['Leave', 'Holiday', 'Weekly Off'].includes(ex.status)) {
      return res.status(409).json({ error: `Today is marked as ${ex.status}` });
    }
    if (ex && ex.check_in) {
      return res.status(409).json({ error: `You already checked in at ${String(ex.check_in).slice(0, 5)}` });
    }
    const row = await upsert({
      empId: emp.id, status: emp.work_mode === 'Remote' ? 'Work From Home' : 'Present',
      checkIn: time, checkOut: undefined, remarks: undefined, keepIn: false, keepOut: true, keepRemarks: true,
    }, date, req.user.id);
    await audit.log(req, { action: 'check_in', module: 'attendance', recordId: row.id, newValue: { date, time } });
    res.json(row);
  } catch (err) {
    console.error('Check-in error:', err);
    res.status(500).json({ error: 'Failed to check in' });
  }
});

// POST /api/attendance/check-out
router.post('/check-out', requireAuth, async (req, res) => {
  try {
    const emp = await employeeForUser(req.user.id);
    if (!emp) return res.status(404).json({ error: 'No employee record is linked to your login. Please ask HR to link it.' });
    const date = hr.todayStr(), time = hr.nowTimeStr();
    const ex = (await sql`SELECT * FROM attendance WHERE employee_id = ${emp.id} AND date = ${date}`)[0];
    if (!ex || !ex.check_in) return res.status(409).json({ error: 'You have not checked in today' });
    if (ex.check_out) return res.status(409).json({ error: `You already checked out at ${String(ex.check_out).slice(0, 5)}` });
    if (time <= String(ex.check_in).slice(0, 5)) return res.status(409).json({ error: 'Check-out must be later than check-in' });
    const rows = await sql`UPDATE attendance SET check_out = ${time}, marked_by = ${req.user.id} WHERE id = ${ex.id} RETURNING *`;
    await audit.log(req, { action: 'check_out', module: 'attendance', recordId: ex.id, newValue: { date, time } });
    res.json(rows[0]);
  } catch (err) {
    console.error('Check-out error:', err);
    res.status(500).json({ error: 'Failed to check out' });
  }
});

module.exports = router;
module.exports._test = { cleanEntry, checkMarkableDate, monthParams };
