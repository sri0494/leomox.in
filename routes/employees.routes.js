'use strict';
const express = require('express');
const { sql } = require('../db');
const { requireAuth, requireAdmin, requireAdminHR, requireHR } = require('../middleware/auth');
const audit = require('../utils/audit');
const hr = require('../utils/hr');
const { employeeForUser, stripForRole, parseIntId, pgMessage } = require('../utils/employee');

const router = express.Router();

/* ── Validation vocab ─────────────────────────────────────────────────── */
const ENUMS = {
  status:         ['Active', 'Inactive', 'On Leave', 'Probation', 'On Notice', 'Resigned', 'Terminated', 'Relieved'],
  gender:         ['Male', 'Female', 'Other'],
  marital_status: ['Single', 'Married', 'Divorced', 'Widowed'],
  blood_group:    ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'],
  emp_type:       ['Full Time', 'Part Time', 'Contract', 'Intern', 'Consultant'],
  work_mode:      ['Office', 'Remote', 'Hybrid'],
};
const ENUM_DEFAULTS = { emp_type: 'Full Time', work_mode: 'Office' };
const TEXT_KEYS = [
  'emp_code', 'first_name', 'last_name', 'dept', 'designation', 'phone', 'email', 'personal_email',
  'location', 'leave_reason', 'perm_address', 'curr_address', 'city', 'state', 'pincode',
  'emg_name', 'emg_relation', 'emg_phone',
];
const MAXLEN = { perm_address: 500, curr_address: 500, leave_reason: 500 };
const DATE_KEYS = ['joined', 'dob', 'confirm_date', 'date_leaving'];
const LABELS = {
  joined: 'Joining date', dob: 'Date of birth', confirm_date: 'Confirmation date', date_leaving: 'Leaving date',
  phone: 'Phone', emg_phone: 'Emergency phone',
};
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BASE_DEFAULTS = { status: 'Active', emp_type: 'Full Time', work_mode: 'Office', notice_period: 30, salary: 0 };

// trim → null when empty → cap length. `undefined` (key absent) passes through.
function str(v, max = 200) {
  if (v === undefined) return undefined;
  if (v === null) return null;
  const s = String(v).trim();
  return s === '' ? null : s.slice(0, max);
}

// Loose equality that copes with Postgres returning NUMERIC/DATE as string/Date.
function same(a, b) {
  const da = hr.toDateStr(a), db = hr.toDateStr(b);
  if (da && db) return da === db;
  const na = a === null || a === undefined ? '' : String(a);
  const nb = b === null || b === undefined ? '' : String(b);
  if (na !== '' && nb !== '' && !isNaN(Number(na)) && !isNaN(Number(nb))) return Number(na) === Number(nb);
  return na === nb;
}

/**
 * Validate + normalise the fields present in `body`.
 * Returns { patch, errors } — `patch` holds only keys that were supplied.
 */
function cleanEmployee(body, existing) {
  const b = body || {};
  const has = (k) => Object.prototype.hasOwnProperty.call(b, k);
  const patch = {};
  const errors = [];

  if (has('name')) {
    const nm = str(b.name, 150);
    if (!nm) errors.push('Name is required'); else patch.name = nm;
  }
  for (const k of TEXT_KEYS) if (has(k)) patch[k] = str(b[k], MAXLEN[k] || 200);

  for (const [k, list] of Object.entries(ENUMS)) {
    if (!has(k)) continue;
    const v = str(b[k]);
    if (v === null || v === undefined) {
      if (k === 'status') errors.push('Status is required');
      else patch[k] = ENUM_DEFAULTS[k] || null;
    } else if (!list.includes(v)) errors.push(`Invalid ${k.replace('_', ' ')}: ${v}`);
    else patch[k] = v;
  }

  if (patch.email && !EMAIL_RE.test(patch.email)) errors.push('Email is not valid');
  if (patch.personal_email && !EMAIL_RE.test(patch.personal_email)) errors.push('Personal email is not valid');
  for (const k of ['phone', 'emg_phone']) {
    if (patch[k]) {
      const digits = patch[k].replace(/\D/g, '').length;
      if (digits < 10 || digits > 15) errors.push(`${LABELS[k]} must contain 10-15 digits`);
    }
  }
  if (patch.pincode && !/^\d{6}$/.test(patch.pincode)) errors.push('Pincode must be 6 digits');
  if (patch.emp_code && !/^[A-Za-z0-9._-]{2,20}$/.test(patch.emp_code)) {
    errors.push('Employee code may only contain letters, numbers, . _ - (2-20 characters)');
  }

  if (has('salary')) {
    const s = b.salary === '' || b.salary === null ? 0 : Number(b.salary);
    if (!Number.isFinite(s) || s < 0 || s > 100000000) errors.push('Salary must be a non-negative number');
    else patch.salary = Math.round(s * 100) / 100;
  }
  if (has('notice_period')) {
    if (b.notice_period === '' || b.notice_period === null) patch.notice_period = 30;
    else {
      const n = Number(b.notice_period);
      if (!Number.isInteger(n) || n < 0 || n > 365) errors.push('Notice period must be 0-365 days');
      else patch.notice_period = n;
    }
  }

  for (const k of DATE_KEYS) {
    if (!has(k)) continue;
    const v = str(b[k]);
    if (v === null || v === undefined) patch[k] = null;
    else if (!hr.isValidDate(v)) errors.push(`${LABELS[k]} is not a valid date`);
    else patch[k] = v;
  }

  // cross-field checks on the merged result
  const fin = { ...(existing || {}), ...patch };
  const joined = hr.toDateStr(fin.joined), leaving = hr.toDateStr(fin.date_leaving);
  const confirm = hr.toDateStr(fin.confirm_date), dob = hr.toDateStr(fin.dob);
  if (dob && (dob >= hr.todayStr() || dob < '1930-01-01')) errors.push('Date of birth is not plausible');
  if (leaving && joined && leaving < joined) errors.push('Leaving date cannot be before the joining date');
  if (confirm && joined && confirm < joined) errors.push('Confirmation date cannot be before the joining date');

  // keep first/last name populated from the single "Full Name" input
  if (patch.name && !has('first_name') && !has('last_name')) {
    const parts = patch.name.split(/\s+/);
    patch.first_name = parts[0];
    patch.last_name = parts.slice(1).join(' ') || null;
  }
  return { patch, errors };
}

// Resolve manager_id / user_id (need DB lookups). Mutates patch; returns error string or null.
async function resolveLinks(body, patch, selfId) {
  const has = (k) => Object.prototype.hasOwnProperty.call(body || {}, k);
  if (has('manager_id')) {
    const raw = body.manager_id;
    if (raw === '' || raw === null || raw === undefined) patch.manager_id = null;
    else {
      const id = parseIntId(raw);
      if (!id) return 'Invalid reporting manager';
      if (selfId && id === selfId) return 'An employee cannot report to themselves';
      const r = await sql`SELECT id FROM employees WHERE id = ${id}`;
      if (!r.length) return 'Reporting manager not found';
      patch.manager_id = id;
    }
  }
  if (has('user_id')) {
    const raw = str(body.user_id);
    if (raw === null || raw === undefined) patch.user_id = null;
    else {
      const r = await sql`SELECT id FROM users WHERE id = ${raw}`;
      if (!r.length) return 'Login user not found';
      patch.user_id = raw;
    }
  }
  return null;
}

/* ── Bank / statutory validation ──────────────────────────────────────── */
function cleanBank(body, existing) {
  const b = body || {};
  const has = (k) => Object.prototype.hasOwnProperty.call(b, k);
  const errors = [];
  const out = { pay_mode: 'Bank Transfer', ...(existing || {}) };
  for (const k of ['holder_name', 'bank_name', 'branch']) if (has(k)) out[k] = str(b[k], 100);
  if (has('account_no')) {
    const v = str(b.account_no);
    const compact = v ? v.replace(/\s+/g, '') : null;
    if (compact && !/^\d{6,20}$/.test(compact)) errors.push('Account number must be 6-20 digits');
    out.account_no = compact;
  }
  if (has('ifsc')) {
    const v = str(b.ifsc);
    const up = v ? v.toUpperCase() : null;
    if (up && !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(up)) errors.push('IFSC must look like SBIN0001234');
    out.ifsc = up;
  }
  if (has('account_type')) {
    const v = str(b.account_type) || null;
    if (v && !['Savings', 'Current', 'Salary'].includes(v)) errors.push('Invalid account type');
    out.account_type = v;
  }
  if (has('pay_mode')) {
    const v = str(b.pay_mode) || 'Bank Transfer';
    if (!['Bank Transfer', 'Cheque', 'Cash', 'UPI'].includes(v)) errors.push('Invalid pay mode');
    out.pay_mode = v;
  }
  return { out, errors };
}

function cleanStatutory(body, existing) {
  const b = body || {};
  const has = (k) => Object.prototype.hasOwnProperty.call(b, k);
  const errors = [];
  const out = { tax_regime: 'New', pt_applicable: false, lwf_applicable: false, tds_applicable: false, ...(existing || {}) };
  if (has('pan')) {
    const v = str(b.pan);
    const up = v ? v.toUpperCase() : null;
    if (up && !/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(up)) errors.push('PAN must look like ABCDE1234F');
    out.pan = up;
  }
  if (has('aadhaar_ref')) {
    const v = str(b.aadhaar_ref);
    if (v && !/^\d{4}$/.test(v)) errors.push('Aadhaar: enter only the last 4 digits');
    out.aadhaar_ref = v;
  }
  if (has('uan')) {
    const v = str(b.uan);
    if (v && !/^\d{12}$/.test(v)) errors.push('UAN must be 12 digits');
    out.uan = v;
  }
  if (has('pf_number')) out.pf_number = str(b.pf_number, 30);
  if (has('esic_number')) {
    const v = str(b.esic_number);
    if (v && !/^\d{10,17}$/.test(v)) errors.push('ESIC number must be 10-17 digits');
    out.esic_number = v;
  }
  for (const k of ['pt_applicable', 'lwf_applicable', 'tds_applicable']) {
    if (has(k)) out[k] = b[k] === true || b[k] === 'true' || b[k] === 1 || b[k] === '1';
  }
  if (has('tax_regime')) {
    const v = str(b.tax_regime) || 'New';
    if (!['Old', 'New'].includes(v)) errors.push('Tax regime must be Old or New');
    out.tax_regime = v;
  }
  return { out, errors };
}

async function loadBank(empId) {
  const r = await sql`SELECT * FROM employee_bank WHERE employee_id = ${empId} LIMIT 1`;
  return r[0] || null;
}
async function loadStatutory(empId) {
  const r = await sql`SELECT * FROM employee_statutory WHERE employee_id = ${empId} LIMIT 1`;
  return r[0] || null;
}

const changedKeys = (before, after) =>
  Object.keys(after).filter((k) => !['id', 'employee_id', 'updated_at'].includes(k) && !same(before ? before[k] : null, after[k]));

/* ── Routes ───────────────────────────────────────────────────────────── */

// GET /api/employees — staff roles only (employees use /me)
router.get('/', requireHR, async (req, res) => {
  try {
    const rows = await sql`SELECT * FROM employees ORDER BY created_at DESC, id DESC`;
    res.json(rows.map((r) => stripForRole(r, req.user.role)));
  } catch (err) {
    console.error('List employees error:', err);
    res.status(500).json({ error: 'Failed to load employees' });
  }
});

// GET /api/employees/me — the logged-in user's own profile (any role)
router.get('/me', requireAuth, async (req, res) => {
  try {
    const employee = await employeeForUser(req.user.id);
    if (!employee) return res.json({ employee: null, bank: null, statutory: null });
    res.json({ employee, bank: await loadBank(employee.id), statutory: await loadStatutory(employee.id) });
  } catch (err) {
    console.error('Get my profile error:', err);
    res.status(500).json({ error: 'Failed to load your profile' });
  }
});

// GET /api/employees/:id — full profile. Bank/statutory only for admin/hr.
router.get('/:id', requireHR, async (req, res) => {
  try {
    const id = parseIntId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid employee id' });
    const rows = await sql`SELECT * FROM employees WHERE id = ${id}`;
    if (!rows.length) return res.status(404).json({ error: 'Employee not found' });
    const privileged = req.user.role === 'admin' || req.user.role === 'hr';
    res.json({
      employee: stripForRole(rows[0], req.user.role),
      bank: privileged ? await loadBank(id) : null,
      statutory: privileged ? await loadStatutory(id) : null,
    });
  } catch (err) {
    console.error('Get employee error:', err);
    res.status(500).json({ error: 'Failed to load employee' });
  }
});

// POST /api/employees — admin or HR
router.post('/', requireAdminHR, async (req, res) => {
  try {
    const { patch, errors } = cleanEmployee(req.body, null);
    if (!patch.name && !errors.some((e) => /^Name/.test(e))) errors.push('Name is required');
    const linkErr = await resolveLinks(req.body, patch, null);
    if (linkErr) errors.push(linkErr);
    if (errors.length) return res.status(400).json({ error: errors.join('; ') });

    const f = { ...BASE_DEFAULTS, ...patch };
    const g = (k) => (f[k] === undefined ? null : f[k]);
    const rows = await sql`
      INSERT INTO employees (
        name, first_name, last_name, emp_code, dept, designation, phone, email, personal_email,
        gender, dob, blood_group, marital_status, salary, joined, confirm_date, status, emp_type,
        manager_id, location, work_mode, notice_period, date_leaving, leave_reason,
        perm_address, curr_address, city, state, pincode, emg_name, emg_relation, emg_phone, user_id
      ) VALUES (
        ${f.name}, ${g('first_name')}, ${g('last_name')}, ${g('emp_code')}, ${g('dept')}, ${g('designation')}, ${g('phone')}, ${g('email')}, ${g('personal_email')},
        ${g('gender')}, ${g('dob')}, ${g('blood_group')}, ${g('marital_status')}, ${f.salary}, ${g('joined')}, ${g('confirm_date')}, ${f.status}, ${f.emp_type},
        ${g('manager_id')}, ${g('location')}, ${f.work_mode}, ${f.notice_period}, ${g('date_leaving')}, ${g('leave_reason')},
        ${g('perm_address')}, ${g('curr_address')}, ${g('city')}, ${g('state')}, ${g('pincode')}, ${g('emg_name')}, ${g('emg_relation')}, ${g('emg_phone')}, ${g('user_id')}
      )
      RETURNING *
    `;
    let emp = rows[0];
    if (!emp.emp_code) {
      const upd = await sql`UPDATE employees SET emp_code = ${'LM' + String(emp.id).padStart(4, '0')} WHERE id = ${emp.id} RETURNING *`;
      emp = upd[0] || emp;
    }
    await audit.log(req, { action: 'create', module: 'employees', recordId: emp.id, newValue: { name: emp.name, emp_code: emp.emp_code } });
    res.status(201).json(emp);
  } catch (err) {
    console.error('Create employee error:', err);
    const m = pgMessage(err);
    res.status(m ? 409 : 500).json({ error: m || 'Failed to create employee' });
  }
});

// PUT /api/employees/:id — admin or HR; partial update (only supplied fields change)
router.put('/:id', requireAdminHR, async (req, res) => {
  try {
    const id = parseIntId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid employee id' });
    const rows0 = await sql`SELECT * FROM employees WHERE id = ${id}`;
    const ex = rows0[0];
    if (!ex) return res.status(404).json({ error: 'Employee not found' });

    const { patch, errors } = cleanEmployee(req.body, ex);
    const linkErr = await resolveLinks(req.body, patch, id);
    if (linkErr) errors.push(linkErr);
    if (errors.length) return res.status(400).json({ error: errors.join('; ') });

    const f = { ...ex, ...patch };
    const rows = await sql`
      UPDATE employees SET
        name = ${f.name}, first_name = ${f.first_name}, last_name = ${f.last_name}, emp_code = ${f.emp_code},
        dept = ${f.dept}, designation = ${f.designation}, phone = ${f.phone}, email = ${f.email}, personal_email = ${f.personal_email},
        gender = ${f.gender}, dob = ${hr.toDateStr(f.dob)}, blood_group = ${f.blood_group}, marital_status = ${f.marital_status},
        salary = ${f.salary}, joined = ${hr.toDateStr(f.joined)}, confirm_date = ${hr.toDateStr(f.confirm_date)},
        status = ${f.status}, emp_type = ${f.emp_type}, manager_id = ${f.manager_id}, location = ${f.location},
        work_mode = ${f.work_mode}, notice_period = ${f.notice_period}, date_leaving = ${hr.toDateStr(f.date_leaving)},
        leave_reason = ${f.leave_reason}, perm_address = ${f.perm_address}, curr_address = ${f.curr_address},
        city = ${f.city}, state = ${f.state}, pincode = ${f.pincode},
        emg_name = ${f.emg_name}, emg_relation = ${f.emg_relation}, emg_phone = ${f.emg_phone}, user_id = ${f.user_id}
      WHERE id = ${id}
      RETURNING *
    `;
    const changed = changedKeys(ex, patch);
    const noSalary = changed.filter((k) => k !== 'salary');
    await audit.log(req, {
      action: 'update', module: 'employees', recordId: id,
      oldValue: Object.fromEntries(noSalary.map((k) => [k, ex[k]])),
      newValue: Object.fromEntries(noSalary.map((k) => [k, patch[k]])),
      reason: changed.includes('salary') ? 'salary changed' : undefined,
    });
    res.json(rows[0]);
  } catch (err) {
    console.error('Update employee error:', err);
    const m = pgMessage(err);
    res.status(m ? 409 : 500).json({ error: m || 'Failed to update employee' });
  }
});

// PUT /api/employees/:id/bank — admin or HR
router.put('/:id/bank', requireAdminHR, async (req, res) => {
  try {
    const id = parseIntId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid employee id' });
    const emp = await sql`SELECT id FROM employees WHERE id = ${id}`;
    if (!emp.length) return res.status(404).json({ error: 'Employee not found' });

    const ex = await loadBank(id);
    const { out, errors } = cleanBank(req.body, ex);
    if (errors.length) return res.status(400).json({ error: errors.join('; ') });

    const n = (k) => (out[k] === undefined ? null : out[k]);
    const rows = ex
      ? await sql`UPDATE employee_bank SET holder_name=${n('holder_name')}, bank_name=${n('bank_name')}, branch=${n('branch')},
                    account_no=${n('account_no')}, ifsc=${n('ifsc')}, account_type=${n('account_type')},
                    pay_mode=${out.pay_mode}, updated_at=NOW() WHERE employee_id=${id} RETURNING *`
      : await sql`INSERT INTO employee_bank (employee_id, holder_name, bank_name, branch, account_no, ifsc, account_type, pay_mode)
                  VALUES (${id}, ${n('holder_name')}, ${n('bank_name')}, ${n('branch')}, ${n('account_no')},
                          ${n('ifsc')}, ${n('account_type')}, ${out.pay_mode}) RETURNING *`;
    await audit.log(req, { action: 'update_bank', module: 'employees', recordId: id, newValue: { fields: changedKeys(ex, out) } });
    res.json(rows[0]);
  } catch (err) {
    console.error('Save bank error:', err);
    res.status(500).json({ error: 'Failed to save bank details' });
  }
});

// PUT /api/employees/:id/statutory — admin or HR
router.put('/:id/statutory', requireAdminHR, async (req, res) => {
  try {
    const id = parseIntId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid employee id' });
    const emp = await sql`SELECT id FROM employees WHERE id = ${id}`;
    if (!emp.length) return res.status(404).json({ error: 'Employee not found' });

    const ex = await loadStatutory(id);
    const { out, errors } = cleanStatutory(req.body, ex);
    if (errors.length) return res.status(400).json({ error: errors.join('; ') });

    const v = (k) => (out[k] === undefined ? null : out[k]);
    const rows = ex
      ? await sql`UPDATE employee_statutory SET pan=${v('pan')}, aadhaar_ref=${v('aadhaar_ref')}, uan=${v('uan')}, pf_number=${v('pf_number')},
                    esic_number=${v('esic_number')}, pt_applicable=${out.pt_applicable}, lwf_applicable=${out.lwf_applicable},
                    tax_regime=${out.tax_regime}, tds_applicable=${out.tds_applicable}, updated_at=NOW()
                  WHERE employee_id=${id} RETURNING *`
      : await sql`INSERT INTO employee_statutory (employee_id, pan, aadhaar_ref, uan, pf_number, esic_number, pt_applicable, lwf_applicable, tax_regime, tds_applicable)
                  VALUES (${id}, ${v('pan')}, ${v('aadhaar_ref')}, ${v('uan')}, ${v('pf_number')}, ${v('esic_number')},
                          ${out.pt_applicable}, ${out.lwf_applicable}, ${out.tax_regime}, ${out.tds_applicable}) RETURNING *`;
    await audit.log(req, { action: 'update_statutory', module: 'employees', recordId: id, newValue: { fields: changedKeys(ex, out) } });
    res.json(rows[0]);
  } catch (err) {
    console.error('Save statutory error:', err);
    res.status(500).json({ error: 'Failed to save statutory details' });
  }
});

// DELETE /api/employees/:id — admin only. Employees with payroll/leave history
// can't be deleted (that would destroy financial records) — mark them Relieved.
router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    const id = parseIntId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid employee id' });
    const rows0 = await sql`SELECT id, name FROM employees WHERE id = ${id}`;
    if (!rows0.length) return res.status(404).json({ error: 'Employee not found' });

    await sql`DELETE FROM employees WHERE id = ${id}`;
    await audit.log(req, { action: 'delete', module: 'employees', recordId: id, oldValue: { name: rows0[0].name } });
    res.json({ ok: true });
  } catch (err) {
    console.error('Delete employee error:', err);
    if (err && err.code === '23503') {
      return res.status(409).json({ error: 'This employee has payroll or leave records and cannot be deleted. Set their status to Relieved/Inactive instead.' });
    }
    res.status(500).json({ error: 'Failed to delete employee' });
  }
});

module.exports = router;
module.exports._test = { cleanEmployee, cleanBank, cleanStatutory, same };
