'use strict';
const express = require('express');
const { sql } = require('../db');
const { requireAuth, requireManager, requireAdminHR } = require('../middleware/auth');
const audit = require('../utils/audit');
const hr = require('../utils/hr');
const { employeeForUser, scopeEmployeeId, parseIntId } = require('../utils/employee');

const router = express.Router();
const STAFF = ['admin', 'manager', 'hr'];
const PENDING = ['Submitted', 'Manager Approved'];

/* ── helpers ──────────────────────────────────────────────────────────── */

// Make sure a balance row exists for every active leave type for this employee/year.
async function ensureBalances(empId, year) {
  await sql`
    INSERT INTO leave_balances (employee_id, leave_type_id, year, accrued)
    SELECT ${empId}::int, id, ${year}::int, annual_days FROM leave_types WHERE active = TRUE
    ON CONFLICT (employee_id, leave_type_id, year) DO NOTHING`;
}

async function getBalances(empId, year) {
  await ensureBalances(empId, year);
  return sql`
    SELECT lb.id, lb.employee_id, lb.leave_type_id, lb.year, lb.opening, lb.accrued, lb.used, lb.pending, lb.closing,
           lt.name AS leave_type_name, lt.paid
    FROM leave_balances lb JOIN leave_types lt ON lt.id = lb.leave_type_id
    WHERE lb.employee_id = ${empId} AND lb.year = ${year} AND lt.active = TRUE
    ORDER BY lt.id`;
}

async function getRequest(id) {
  const rows = await sql`
    SELECT lr.*, e.name AS employee_name, e.user_id AS employee_user_id, lt.name AS leave_type_name, lt.paid
    FROM leave_requests lr
    JOIN employees e ON e.id = lr.employee_id
    JOIN leave_types lt ON lt.id = lr.leave_type_id
    WHERE lr.id = ${id}`;
  return rows[0] || null;
}

const yearOf = (d) => Number(String(hr.toDateStr(d)).slice(0, 4));

async function releasePending(lr) {
  await sql`UPDATE leave_balances SET pending = GREATEST(pending - ${Number(lr.days)}, 0)
            WHERE employee_id = ${lr.employee_id} AND leave_type_id = ${lr.leave_type_id} AND year = ${yearOf(lr.from_date)}`;
}

async function notifyUser(userId, title, message) {
  if (!userId) return;
  try { await sql`INSERT INTO notifications (user_id, title, message, type) VALUES (${userId}, ${title}, ${message}, 'leave')`; }
  catch (e) { console.error('notifyUser failed:', e.message); }
}
async function notifyApprovers(exceptUserId, title, message) {
  try {
    await sql`INSERT INTO notifications (user_id, title, message, type)
              SELECT id, ${title}::text, ${message}::text, 'leave' FROM users
              WHERE role IN ('hr','manager','admin') AND active = TRUE AND id <> ${exceptUserId || ''}`;
  } catch (e) { console.error('notifyApprovers failed:', e.message); }
}

// Final approval: consume balance and write the days into attendance.
async function finalizeApproval(lr, actorId) {
  const days = Number(lr.days);
  await sql`UPDATE leave_balances SET pending = GREATEST(pending - ${days}, 0), used = used + ${days}
            WHERE employee_id = ${lr.employee_id} AND leave_type_id = ${lr.leave_type_id} AND year = ${yearOf(lr.from_date)}`;

  const dates = hr.eachDate(hr.toDateStr(lr.from_date), hr.toDateStr(lr.to_date)).filter((d) => !hr.isSunday(d));
  const status = lr.paid ? 'Leave' : (lr.half_day ? 'Half Day' : 'Absent');   // unpaid => counts as LOP in payroll
  const remark = `${lr.leave_type_name}${lr.half_day ? ' (half day)' : ''}`;
  const locked = await sql`SELECT month, year FROM payroll WHERE employee_id = ${lr.employee_id} AND status = 'Locked'`;
  const lockedKeys = new Set(locked.map((r) => `${r.year}-${String(r.month).padStart(2, '0')}`));
  for (const d of dates) {
    if (lockedKeys.has(d.slice(0, 7))) continue; // never touch a locked payroll month
    await sql`
      INSERT INTO attendance (employee_id, date, status, marked_by, remarks)
      VALUES (${lr.employee_id}, ${d}, ${status}, ${actorId}, ${remark})
      ON CONFLICT (employee_id, date) DO UPDATE SET
        status = EXCLUDED.status, marked_by = EXCLUDED.marked_by, remarks = EXCLUDED.remarks,
        check_in = NULL, check_out = NULL`;
  }
}

const isOwnRequest = (lr, req) => lr.employee_user_id && lr.employee_user_id === req.user.id;

/* ── reads ────────────────────────────────────────────────────────────── */

router.get('/types', requireAuth, async (req, res) => {
  try {
    res.json(await sql`SELECT * FROM leave_types WHERE active = TRUE ORDER BY id`);
  } catch (err) {
    console.error('List leave types error:', err);
    res.status(500).json({ error: 'Failed to load leave types' });
  }
});

// GET /api/leave/balances?employeeId=&year=
router.get('/balances', requireAuth, async (req, res) => {
  try {
    const year = req.query.year ? Number(req.query.year) : Number(hr.todayStr().slice(0, 4));
    if (!Number.isInteger(year) || year < 2000 || year > 2100) return res.status(400).json({ error: 'Invalid year' });
    const scope = await scopeEmployeeId(req, req.query.employeeId);
    if (scope.error) return res.status(scope.status).json({ error: scope.error });
    let empId = scope.id;
    if (!empId && STAFF.includes(req.user.role)) {
      const own = await employeeForUser(req.user.id);
      empId = own ? own.id : null;
    }
    if (!empId) return res.json([]);
    res.json(await getBalances(empId, year));
  } catch (err) {
    console.error('Leave balances error:', err);
    res.status(500).json({ error: 'Failed to load leave balances' });
  }
});

// GET /api/leave/requests?status=Submitted — staff see everyone's, employees only their own
router.get('/requests', requireAuth, async (req, res) => {
  try {
    const scope = await scopeEmployeeId(req, null);
    if (scope.error) return res.status(scope.status).json({ error: scope.error });
    const rows = scope.id
      ? await sql`SELECT lr.*, e.name AS employee_name, e.emp_code, e.dept, lt.name AS leave_type_name, lt.paid
                  FROM leave_requests lr JOIN employees e ON e.id = lr.employee_id JOIN leave_types lt ON lt.id = lr.leave_type_id
                  WHERE lr.employee_id = ${scope.id} ORDER BY lr.created_at DESC, lr.id DESC LIMIT 500`
      : await sql`SELECT lr.*, e.name AS employee_name, e.emp_code, e.dept, lt.name AS leave_type_name, lt.paid
                  FROM leave_requests lr JOIN employees e ON e.id = lr.employee_id JOIN leave_types lt ON lt.id = lr.leave_type_id
                  ORDER BY lr.created_at DESC, lr.id DESC LIMIT 500`;
    res.json(req.query.status ? rows.filter((r) => r.status === req.query.status) : rows);
  } catch (err) {
    console.error('List leave requests error:', err);
    res.status(500).json({ error: 'Failed to load leave requests' });
  }
});

/* ── apply ────────────────────────────────────────────────────────────── */

// POST /api/leave/requests — { leaveTypeId, fromDate, toDate, halfDay, reason, employeeId? }
// employeeId (apply on someone's behalf) is honoured for admin/hr only.
router.post('/requests', requireAuth, async (req, res) => {
  try {
    const { leaveTypeId, fromDate, toDate, halfDay, reason, employeeId } = req.body || {};

    let emp;
    const onBehalf = employeeId !== undefined && employeeId !== null && employeeId !== '' && ['admin', 'hr'].includes(req.user.role);
    if (onBehalf) {
      emp = (await sql`SELECT * FROM employees WHERE id = ${parseIntId(employeeId)}`)[0];
      if (!emp) return res.status(404).json({ error: 'Employee not found' });
    } else {
      emp = await employeeForUser(req.user.id);
      if (!emp) return res.status(400).json({ error: 'No employee record is linked to your login. Please ask HR to link it.' });
    }

    const ltId = parseIntId(leaveTypeId);
    const lt = ltId ? (await sql`SELECT * FROM leave_types WHERE id = ${ltId} AND active = TRUE`)[0] : null;
    if (!lt) return res.status(400).json({ error: 'Please choose a valid leave type' });

    if (!hr.isValidDate(fromDate) || !hr.isValidDate(toDate)) return res.status(400).json({ error: 'Please choose valid from/to dates' });
    if (toDate < fromDate) return res.status(400).json({ error: 'To-date cannot be before from-date' });
    if (fromDate.slice(0, 4) !== toDate.slice(0, 4)) return res.status(400).json({ error: 'A request cannot span two calendar years — please split it at 31 Dec' });
    if (fromDate < hr.addDays(hr.todayStr(), -90)) return res.status(400).json({ error: 'Leave cannot be applied for dates more than 90 days in the past' });
    const half = halfDay === true || halfDay === 'true';
    if (half && fromDate !== toDate) return res.status(400).json({ error: 'Half-day leave must be a single day' });
    const cleanReason = String(reason || '').trim().slice(0, 500);
    if (cleanReason.length < 3) return res.status(400).json({ error: 'Please give a reason for the leave' });

    const days = hr.calcLeaveDays(fromDate, toDate, half);
    if (days <= 0) return res.status(400).json({ error: 'The selected date(s) contain no working days (Sundays are the weekly off)' });

    const overlap = await sql`
      SELECT id FROM leave_requests
      WHERE employee_id = ${emp.id} AND status IN ('Submitted','Manager Approved','HR Approved')
        AND from_date <= ${toDate} AND to_date >= ${fromDate} LIMIT 1`;
    if (overlap.length) return res.status(409).json({ error: 'You already have a leave request covering some of these dates' });

    const year = Number(fromDate.slice(0, 4));
    if (lt.paid) {
      const bal = (await getBalances(emp.id, year)).find((b) => b.leave_type_id === lt.id);
      const available = bal ? Number(bal.closing) - Number(bal.pending) : 0;
      if (days > available) {
        return res.status(400).json({ error: `Insufficient ${lt.name} balance: ${available} day(s) available, ${days} requested` });
      }
    } else {
      await ensureBalances(emp.id, year);
    }

    const rows = await sql`
      INSERT INTO leave_requests (employee_id, leave_type_id, from_date, to_date, days, half_day, reason, status)
      VALUES (${emp.id}, ${lt.id}, ${fromDate}, ${toDate}, ${days}, ${half}, ${cleanReason}, 'Submitted')
      RETURNING *`;
    await sql`UPDATE leave_balances SET pending = pending + ${days}
              WHERE employee_id = ${emp.id} AND leave_type_id = ${lt.id} AND year = ${year}`;

    await audit.log(req, { action: 'apply', module: 'leave', recordId: rows[0].id, newValue: { employee: emp.name, type: lt.name, fromDate, toDate, days } });
    await notifyApprovers(req.user.id, 'New leave request', `${emp.name} requested ${days} day(s) of ${lt.name} (${fromDate}${fromDate !== toDate ? ' to ' + toDate : ''}).`);
    if (onBehalf) await notifyUser(emp.user_id, 'Leave applied for you', `HR applied ${days} day(s) of ${lt.name} for you (${fromDate}).`);
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('Apply leave error:', err);
    res.status(500).json({ error: 'Failed to submit leave request' });
  }
});

/* ── approval workflow ────────────────────────────────────────────────── */

function readAction(body) {
  const action = body && body.action;
  const remark = String((body && body.remark) || '').trim().slice(0, 300);
  if (!['Approved', 'Rejected'].includes(action)) return { error: 'action must be Approved or Rejected' };
  if (action === 'Rejected' && remark.length < 3) return { error: 'Please give a reason for rejecting the request' };
  return { action, remark };
}

// PUT /api/leave/requests/:id/manager-action — step 1 (manager / admin)
router.put('/requests/:id/manager-action', requireManager, async (req, res) => {
  try {
    const id = parseIntId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid request id' });
    const a = readAction(req.body);
    if (a.error) return res.status(400).json({ error: a.error });

    const lr = await getRequest(id);
    if (!lr) return res.status(404).json({ error: 'Leave request not found' });
    if (lr.status !== 'Submitted') return res.status(409).json({ error: `This request is already "${lr.status}"` });
    if (isOwnRequest(lr, req) && req.user.role !== 'admin') return res.status(403).json({ error: 'You cannot approve your own leave request' });

    const status = a.action === 'Approved' ? 'Manager Approved' : 'Rejected';
    const rows = await sql`
      UPDATE leave_requests SET manager_action = ${a.action}, manager_remark = ${a.remark || null}, manager_at = NOW(),
        status = ${status}, actioned_by = ${req.user.id}
      WHERE id = ${id} RETURNING *`;
    if (a.action === 'Rejected') {
      await releasePending(lr);
      await notifyUser(lr.employee_user_id, 'Leave rejected', `Your ${lr.leave_type_name} request was rejected: ${a.remark}`);
    } else {
      await notifyUser(lr.employee_user_id, 'Leave approved by manager', `Your ${lr.leave_type_name} request is approved by your manager and awaits HR.`);
    }
    await audit.log(req, { action: 'manager_action', module: 'leave', recordId: id, newValue: { action: a.action, remark: a.remark } });
    res.json(rows[0]);
  } catch (err) {
    console.error('Manager leave action error:', err);
    res.status(500).json({ error: 'Failed to update leave request' });
  }
});

// PUT /api/leave/requests/:id/hr-action — final decision (hr / admin)
router.put('/requests/:id/hr-action', requireAdminHR, async (req, res) => {
  try {
    const id = parseIntId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid request id' });
    const a = readAction(req.body);
    if (a.error) return res.status(400).json({ error: a.error });

    const lr = await getRequest(id);
    if (!lr) return res.status(404).json({ error: 'Leave request not found' });
    if (!PENDING.includes(lr.status)) return res.status(409).json({ error: `This request is already "${lr.status}"` });
    if (isOwnRequest(lr, req) && req.user.role !== 'admin') return res.status(403).json({ error: 'You cannot approve your own leave request' });

    const status = a.action === 'Approved' ? 'HR Approved' : 'Rejected';
    const rows = await sql`
      UPDATE leave_requests SET hr_action = ${a.action}, hr_remark = ${a.remark || null}, hr_at = NOW(),
        status = ${status}, actioned_by = ${req.user.id}
      WHERE id = ${id} RETURNING *`;
    if (a.action === 'Approved') {
      await finalizeApproval(lr, req.user.id);
      await notifyUser(lr.employee_user_id, 'Leave approved', `Your ${lr.leave_type_name} request (${hr.toDateStr(lr.from_date)}) has been approved.`);
    } else {
      await releasePending(lr);
      await notifyUser(lr.employee_user_id, 'Leave rejected', `Your ${lr.leave_type_name} request was rejected: ${a.remark}`);
    }
    await audit.log(req, { action: 'hr_action', module: 'leave', recordId: id, newValue: { action: a.action, remark: a.remark } });
    res.json(rows[0]);
  } catch (err) {
    console.error('HR leave action error:', err);
    res.status(500).json({ error: 'Failed to update leave request' });
  }
});

// PUT /api/leave/requests/:id/cancel — the requester, or admin/hr; only while still pending
router.put('/requests/:id/cancel', requireAuth, async (req, res) => {
  try {
    const id = parseIntId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid request id' });
    const lr = await getRequest(id);
    if (!lr) return res.status(404).json({ error: 'Leave request not found' });
    if (!isOwnRequest(lr, req) && !['admin', 'hr'].includes(req.user.role)) return res.status(403).json({ error: 'You can only cancel your own requests' });
    if (!PENDING.includes(lr.status)) return res.status(409).json({ error: 'Only pending requests can be cancelled' });

    const rows = await sql`UPDATE leave_requests SET status = 'Cancelled' WHERE id = ${id} RETURNING *`;
    await releasePending(lr);
    await audit.log(req, { action: 'cancel', module: 'leave', recordId: id });
    res.json(rows[0]);
  } catch (err) {
    console.error('Cancel leave error:', err);
    res.status(500).json({ error: 'Failed to cancel leave request' });
  }
});

module.exports = router;
