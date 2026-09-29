'use strict';
const express = require('express');
const { sql } = require('../db');
const { requireAuth, requireAdmin, requireAdminHR } = require('../middleware/auth');
const audit = require('../utils/audit');
const hr = require('../utils/hr');
const { employeeForUser, parseIntId } = require('../utils/employee');

const router = express.Router();
const NOT_PAYABLE = ['Inactive', 'Resigned', 'Terminated', 'Relieved'];
const PUBLISHED = ['Approved', 'Locked'];

/* ── helpers ──────────────────────────────────────────────────────────── */

function monthYear(src) {
  const today = hr.todayStr();
  const month = src && src.month !== undefined ? Number(src.month) : Number(today.slice(5, 7));
  const year = src && src.year !== undefined ? Number(src.year) : Number(today.slice(0, 4));
  if (!Number.isInteger(month) || month < 1 || month > 12 || !Number.isInteger(year) || year < 2000 || year > 2100) return null;
  return { month, year };
}

// Is this employee payable for the given month?
function eligible(emp, start, end) {
  const joined = hr.toDateStr(emp.joined), leaving = hr.toDateStr(emp.date_leaving);
  if (joined && joined > end) return false;
  if (leaving && leaving < start) return false;
  if (NOT_PAYABLE.includes(emp.status)) return !!(leaving && leaving >= start && leaving <= end);
  return true;
}

/**
 * Compute (or read back, once approved/locked) payroll for every employee for a month.
 * LOP = Absent/Half-Day attendance + days outside the employment window.
 */
async function buildEntries(month, year, onlyEmployeeId) {
  const { start, end } = hr.monthRange(year, month);
  const employees = onlyEmployeeId
    ? await sql`SELECT * FROM employees WHERE id = ${onlyEmployeeId}`
    : await sql`SELECT * FROM employees ORDER BY name`;
  const [att, stat, structs, stored] = await Promise.all([
    sql`SELECT employee_id, status FROM attendance WHERE date BETWEEN ${start} AND ${end}`,
    sql`SELECT * FROM employee_statutory`,
    sql`SELECT DISTINCT ON (employee_id) * FROM employee_salary WHERE effective_from <= ${end} ORDER BY employee_id, effective_from DESC, id DESC`,
    sql`SELECT * FROM payroll WHERE month = ${month} AND year = ${year}`,
  ]);
  const attBy = new Map(), statBy = new Map(), structBy = new Map(), storedBy = new Map();
  for (const a of att) { if (!attBy.has(a.employee_id)) attBy.set(a.employee_id, []); attBy.get(a.employee_id).push(a); }
  for (const s of stat) statBy.set(s.employee_id, s);
  for (const s of structs) structBy.set(s.employee_id, s);
  for (const p of stored) storedBy.set(p.employee_id, p);

  const out = [];
  for (const emp of employees) {
    if (!eligible(emp, start, end)) continue;
    const lop = hr.lopFromAttendance(attBy.get(emp.id)) + hr.daysOutsideEmployment(year, month, emp.joined, emp.date_leaving);
    const computed = hr.computePayroll({
      employee: emp, structure: structBy.get(emp.id), statutory: statBy.get(emp.id), lopDays: lop, month, year,
    });
    const row = storedBy.get(emp.id);
    const entry = row && PUBLISHED.includes(row.status) ? hr.rowToEntry(row) : computed;
    out.push({
      employeeId: emp.id, empCode: emp.emp_code, name: emp.name, designation: emp.designation, dept: emp.dept,
      payrollId: row ? row.id : null, status: row ? row.status : 'Not Generated',
      hasSalary: computed.gross > 0 || !!structBy.get(emp.id), ...entry,
    });
  }
  return out;
}

function totals(entries) {
  return entries.reduce((t, e) => ({ gross: t.gross + e.gross, deductions: t.deductions + e.totalDed, net: t.net + e.netPay, count: t.count + 1 }),
    { gross: 0, deductions: 0, net: 0, count: 0 });
}

const maskAccount = (a) => (a ? 'X'.repeat(Math.max(String(a).length - 4, 0)) + String(a).slice(-4) : null);

/* ── reads ────────────────────────────────────────────────────────────── */

// GET /api/payroll/preview?month=&year= — admin / HR
router.get('/preview', requireAdminHR, async (req, res) => {
  try {
    const my = monthYear(req.query);
    if (!my) return res.status(400).json({ error: 'Invalid month/year' });
    const entries = await buildEntries(my.month, my.year);
    res.json({ ...my, entries, totals: totals(entries) });
  } catch (err) {
    console.error('Payroll preview error:', err);
    res.status(500).json({ error: 'Failed to load payroll' });
  }
});

// GET /api/payroll/my — the caller's own PUBLISHED payslips
router.get('/my', requireAuth, async (req, res) => {
  try {
    const emp = await employeeForUser(req.user.id);
    if (!emp) return res.json([]);
    res.json(await sql`
      SELECT id, month, year, gross, total_ded, net_pay, status FROM payroll
      WHERE employee_id = ${emp.id} AND status IN ('Approved','Locked')
      ORDER BY year DESC, month DESC LIMIT 36`);
  } catch (err) {
    console.error('My payslips error:', err);
    res.status(500).json({ error: 'Failed to load your payslips' });
  }
});

// GET /api/payroll/payslip?employeeId=&month=&year=
router.get('/payslip', requireAuth, async (req, res) => {
  try {
    const my = monthYear(req.query);
    if (!my) return res.status(400).json({ error: 'Invalid month/year' });

    const staff = ['admin', 'hr'].includes(req.user.role);
    let emp;
    if (staff && req.query.employeeId) {
      const id = parseIntId(req.query.employeeId);
      emp = id ? (await sql`SELECT * FROM employees WHERE id = ${id}`)[0] : null;
      if (!emp) return res.status(404).json({ error: 'Employee not found' });
    } else {
      emp = await employeeForUser(req.user.id);
      if (!emp) return res.status(404).json({ error: 'No employee record is linked to your login. Please ask HR to link it.' });
      if (req.query.employeeId && Number(req.query.employeeId) !== emp.id) {
        return res.status(403).json({ error: 'You can only view your own payslip' });
      }
    }

    const entry = (await buildEntries(my.month, my.year, emp.id))[0];
    if (!entry) return res.status(404).json({ error: 'No payroll for this employee in the selected month' });
    if (!staff && !PUBLISHED.includes(entry.status)) return res.status(403).json({ error: 'This month\'s payslip has not been published yet' });

    const [bank, stat, lv] = await Promise.all([
      sql`SELECT bank_name, account_no, pay_mode FROM employee_bank WHERE employee_id = ${emp.id} LIMIT 1`,
      sql`SELECT pan, uan, pf_number, esic_number FROM employee_statutory WHERE employee_id = ${emp.id} LIMIT 1`,
      sql`SELECT COUNT(*)::int AS n, COALESCE(SUM(lb.opening + lb.accrued), 0) AS total, COALESCE(SUM(lb.used), 0) AS used
          FROM leave_balances lb JOIN leave_types lt ON lt.id = lb.leave_type_id
          WHERE lb.employee_id = ${emp.id} AND lb.year = ${my.year} AND lt.paid = TRUE AND lt.annual_days > 0`,
    ]);
    let total = Number(lv[0].total), used = Number(lv[0].used);
    if (!lv[0].n) {   // no balance rows yet -> show the policy entitlement
      const pol = await sql`SELECT COALESCE(SUM(annual_days), 0) AS total FROM leave_types WHERE active = TRUE AND paid = TRUE`;
      total = Number(pol[0].total); used = 0;
    }
    res.json({
      entry,
      employee: { id: emp.id, emp_code: emp.emp_code, name: emp.name, designation: emp.designation, dept: emp.dept, joined: emp.joined, status: emp.status, location: emp.location },
      bank: bank[0] ? { bank_name: bank[0].bank_name, account_no: maskAccount(bank[0].account_no), pay_mode: bank[0].pay_mode } : null,
      statutory: stat[0] || null,
      leave: { total, used, balance: total - used },
    });
  } catch (err) {
    console.error('Payslip error:', err);
    res.status(500).json({ error: 'Failed to build payslip' });
  }
});

/* ── writes ───────────────────────────────────────────────────────────── */

// POST /api/payroll/generate — { month, year } (admin / HR). Approved/Locked rows are never overwritten.
router.post('/generate', requireAdminHR, async (req, res) => {
  try {
    const my = monthYear(req.body);
    if (!my) return res.status(400).json({ error: 'Valid month and year are required' });
    const today = hr.todayStr();
    if (my.year * 100 + my.month > Number(today.slice(0, 4)) * 100 + Number(today.slice(5, 7))) {
      return res.status(400).json({ error: 'Payroll cannot be generated for a future month' });
    }
    const entries = await buildEntries(my.month, my.year);
    const skipped = [];
    let generated = 0;
    for (const e of entries) {
      if (PUBLISHED.includes(e.status)) { skipped.push({ employeeId: e.employeeId, name: e.name, reason: `Already ${e.status}` }); continue; }
      if (!e.hasSalary) { skipped.push({ employeeId: e.employeeId, name: e.name, reason: 'No salary set' }); continue; }
      await sql`
        INSERT INTO payroll (month, year, employee_id, paid_days, lop_days, basic, hra, conveyance, medical, special, other_earn, gross,
                             emp_pf, emp_esi, prof_tax, tds, other_ded, total_ded, net_pay, er_pf, er_esi, gratuity, status, created_by)
        VALUES (${my.month}, ${my.year}, ${e.employeeId}, ${e.paidDays}, ${e.lopDays}, ${e.basic}, ${e.hra}, ${e.conveyance}, ${e.medical},
                ${e.special}, ${e.otherEarn}, ${e.gross}, ${e.empPf}, ${e.empEsi}, ${e.profTax}, ${e.tds}, ${e.otherDed}, ${e.totalDed},
                ${e.netPay}, ${e.erPf}, ${e.erEsi}, ${e.gratuity}, 'Draft', ${req.user.id})
        ON CONFLICT (employee_id, month, year) DO UPDATE SET
          paid_days = EXCLUDED.paid_days, lop_days = EXCLUDED.lop_days, basic = EXCLUDED.basic, hra = EXCLUDED.hra,
          conveyance = EXCLUDED.conveyance, medical = EXCLUDED.medical, special = EXCLUDED.special, other_earn = EXCLUDED.other_earn,
          gross = EXCLUDED.gross, emp_pf = EXCLUDED.emp_pf, emp_esi = EXCLUDED.emp_esi, prof_tax = EXCLUDED.prof_tax, tds = EXCLUDED.tds,
          other_ded = EXCLUDED.other_ded, total_ded = EXCLUDED.total_ded, net_pay = EXCLUDED.net_pay, er_pf = EXCLUDED.er_pf,
          er_esi = EXCLUDED.er_esi, gratuity = EXCLUDED.gratuity
        WHERE payroll.status IN ('Draft','Generated')`;
      generated++;
    }
    await audit.log(req, { action: 'generate', module: 'payroll', recordId: `${my.month}/${my.year}`, newValue: { generated, skipped: skipped.length } });
    res.status(201).json({ ...my, generated, skipped });
  } catch (err) {
    console.error('Generate payroll error:', err);
    res.status(500).json({ error: 'Failed to generate payroll' });
  }
});

// POST /api/payroll/approve-all — { month, year } (admin): Draft -> Approved (publishes payslips)
router.post('/approve-all', requireAdmin, async (req, res) => {
  try {
    const my = monthYear(req.body);
    if (!my) return res.status(400).json({ error: 'Valid month and year are required' });
    const rows = await sql`UPDATE payroll SET status = 'Approved' WHERE month = ${my.month} AND year = ${my.year} AND status IN ('Draft','Generated') RETURNING id`;
    await audit.log(req, { action: 'approve_all', module: 'payroll', recordId: `${my.month}/${my.year}`, newValue: { count: rows.length } });
    res.json({ ...my, approved: rows.length });
  } catch (err) {
    console.error('Approve payroll error:', err);
    res.status(500).json({ error: 'Failed to approve payroll' });
  }
});

// POST /api/payroll/lock — { month, year } (admin): Approved -> Locked (also freezes attendance)
router.post('/lock', requireAdmin, async (req, res) => {
  try {
    const my = monthYear(req.body);
    if (!my) return res.status(400).json({ error: 'Valid month and year are required' });
    const rows = await sql`UPDATE payroll SET status = 'Locked', locked_by = ${req.user.id}, locked_at = NOW()
                           WHERE month = ${my.month} AND year = ${my.year} AND status = 'Approved' RETURNING id`;
    await audit.log(req, { action: 'lock', module: 'payroll', recordId: `${my.month}/${my.year}`, newValue: { count: rows.length } });
    res.json({ ...my, locked: rows.length });
  } catch (err) {
    console.error('Lock payroll error:', err);
    res.status(500).json({ error: 'Failed to lock payroll' });
  }
});

module.exports = router;
module.exports._test = { eligible, monthYear, totals, maskAccount };
