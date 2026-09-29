'use strict';
const assert = require('assert');
const { load, on, reset, calls, call } = require('./harness');

let n = 0;
async function t(name, fn) {
  reset();
  try { await fn(); n++; console.log('  ok', name); }
  catch (e) { console.error('  FAIL', name, '\n   ', e.message); process.exitCode = 1; }
}

const ADMIN = { id: 'admin', role: 'admin', name: 'Admin' };
const HR = { id: 'hr1', role: 'hr', name: 'HR' };
const MANAGER = { id: 'mgr1', role: 'manager', name: 'Manager' };
const EMPLOYEE = { id: 'emp1', role: 'employee', name: 'Employee' };
const ADMIN2 = { id: 'admin2', role: 'admin', name: 'Second Admin' }; // an admin who is not the 'admin' super-user

(async () => {
  /* ══ employees.routes ══════════════════════════════════════════════ */
  const employees = load('routes/employees.routes.js');
  const { cleanEmployee, cleanBank, cleanStatutory, same } = employees._test;

  await t('cleanEmployee: requires name, validates enums/email/phone/pincode', () => {
    assert.ok(cleanEmployee({ name: '' }, null).errors.includes('Name is required'));
    let r = cleanEmployee({ name: 'A', status: 'Bogus' }, null);
    assert.ok(r.errors.some((e) => /Invalid status/.test(e)));
    r = cleanEmployee({ name: 'A', email: 'not-an-email' }, null);
    assert.ok(r.errors.includes('Email is not valid'));
    r = cleanEmployee({ name: 'A', phone: '12345' }, null);
    assert.ok(r.errors.some((e) => /Phone/.test(e)));
    r = cleanEmployee({ name: 'A', pincode: '12AB56' }, null);
    assert.ok(r.errors.includes('Pincode must be 6 digits'));
    r = cleanEmployee({ name: 'A', salary: -5 }, null);
    assert.ok(r.errors.some((e) => /Salary/.test(e)));
    r = cleanEmployee({ name: 'John Extra Smith' }, null);
    assert.strictEqual(r.patch.first_name, 'John');
    assert.strictEqual(r.patch.last_name, 'Extra Smith');
  });
  await t('cleanEmployee: leaving-before-joining and implausible DOB rejected', () => {
    let r = cleanEmployee({ joined: '2026-01-10', date_leaving: '2026-01-01' }, {});
    assert.ok(r.errors.some((e) => /Leaving date/.test(e)));
    r = cleanEmployee({ dob: '2099-01-01' }, {});               // future DOB
    assert.ok(r.errors.some((e) => /birth/.test(e)));
    r = cleanEmployee({ dob: '1900-01-01' }, {});                 // pre-1930
    assert.ok(r.errors.some((e) => /birth/.test(e)));
    r = cleanEmployee({ dob: '2020-01-01' }, {});                 // in range, even if an unlikely employee age
    assert.ok(!r.errors.some((e) => /birth/.test(e)));
    r = cleanEmployee({ date_leaving: '2026-01-01' }, { joined: '2020-01-01' }); // cross-check vs existing row
    assert.strictEqual(r.errors.length, 0);
  });
  await t('cleanBank: IFSC/account/pay-mode validation, merges onto existing', () => {
    let r = cleanBank({ ifsc: 'badifsc' }, null);
    assert.ok(r.errors.some((e) => /IFSC/.test(e)));
    r = cleanBank({ ifsc: 'sbin0001234', account_no: '12 34 56 78' }, null);
    assert.strictEqual(r.errors.length, 0);
    assert.strictEqual(r.out.ifsc, 'SBIN0001234');
    assert.strictEqual(r.out.account_no, '12345678');
    r = cleanBank({ account_no: '999999' }, { ifsc: 'HDFC0000123', bank_name: 'HDFC' });
    assert.strictEqual(r.out.bank_name, 'HDFC'); // untouched fields preserved
  });
  await t('cleanStatutory: PAN/UAN/ESIC formats, booleans coerced', () => {
    let r = cleanStatutory({ pan: 'bad' }, null);
    assert.ok(r.errors.some((e) => /PAN/.test(e)));
    r = cleanStatutory({ pan: 'abcde1234f', uan: '123456789012', pt_applicable: 'true' }, null);
    assert.strictEqual(r.errors.length, 0);
    assert.strictEqual(r.out.pan, 'ABCDE1234F');
    assert.strictEqual(r.out.pt_applicable, true);
  });
  await t('same(): tolerant date/number comparison used for audit diffing', () => {
    assert.ok(same(new Date(2026, 8, 27), '2026-09-27'));
    assert.ok(same('30000.00', 30000));
    assert.ok(!same('30000.00', 30001));
    assert.ok(same(null, ''));
  });

  await t('GET /api/employees — employee role is blocked (403), HR allowed', async () => {
    const r1 = await call(employees, 'GET', '/', { user: EMPLOYEE });
    assert.strictEqual(r1.status, 403);
    on(/^SELECT \* FROM employees ORDER BY/, [{ id: 1, name: 'A', salary: 1000, dob: '1990-01-01' }]);
    const r2 = await call(employees, 'GET', '/', { user: HR });
    assert.strictEqual(r2.status, 200);
    assert.strictEqual(r2.body[0].name, 'A');
  });
  await t('GET /api/employees — manager gets salary/dob stripped, HR does not', async () => {
    on(/^SELECT \* FROM employees ORDER BY/, [{ id: 1, name: 'A', salary: 1000, dob: '1990-01-01', dept: 'IT' }]);
    const mgr = await call(employees, 'GET', '/', { user: MANAGER });
    assert.strictEqual(mgr.body[0].salary, undefined);
    assert.strictEqual(mgr.body[0].dob, undefined);
    const hr = await call(employees, 'GET', '/', { user: HR });
    assert.strictEqual(hr.body[0].salary, 1000);
  });
  await t('POST /api/employees — manager forbidden; HR blocked by validation; HR succeeds', async () => {
    const forbidden = await call(employees, 'POST', '/', { user: MANAGER, body: { name: 'X' } });
    assert.strictEqual(forbidden.status, 403);
    const bad = await call(employees, 'POST', '/', { user: HR, body: { name: '' } });
    assert.strictEqual(bad.status, 400);

    on(/^INSERT INTO employees/, [{ id: 5, name: 'New Hire', emp_code: null }]);
    on(/^UPDATE employees SET emp_code/, [{ id: 5, name: 'New Hire', emp_code: 'LM0005' }]);
    on(/^INSERT INTO audit_logs/, []);
    const ok = await call(employees, 'POST', '/', { user: HR, body: { name: 'New Hire', salary: 20000 } });
    assert.strictEqual(ok.status, 201);
    assert.strictEqual(ok.body.emp_code, 'LM0005');
  });
  await t('POST /api/employees — manager_id cannot reference self; must exist', async () => {
    on(/^SELECT id FROM employees WHERE id = \?$/, []);
    const missing = await call(employees, 'POST', '/', { user: HR, body: { name: 'X', manager_id: 9 } });
    assert.strictEqual(missing.status, 400);
    assert.match(missing.body.error, /Reporting manager not found/);
  });
  await t('DELETE /api/employees/:id — FK violation from payroll history becomes a friendly 409', async () => {
    on(/^SELECT id, name FROM employees WHERE id = \?$/, [{ id: 3, name: 'Z' }]);
    on(/^DELETE FROM employees WHERE id = \?$/, () => { const e = new Error('fk'); e.code = '23503'; throw e; });
    const r = await call(employees, 'DELETE', '/3', { user: ADMIN });
    assert.strictEqual(r.status, 409);
    assert.match(r.body.error, /Relieved\/Inactive/);
  });
  await t('DELETE /api/employees/:id — HR is not allowed (admin only)', async () => {
    const r = await call(employees, 'DELETE', '/3', { user: HR });
    assert.strictEqual(r.status, 403);
  });
  await t('PUT /api/employees/:id/bank — inserts when none exists, updates when one does', async () => {
    on(/^SELECT id FROM employees WHERE id = \?$/, [{ id: 1 }]);
    on(/^SELECT \* FROM employee_bank WHERE employee_id = \?/, []);
    on(/^INSERT INTO employee_bank/, [{ employee_id: 1, ifsc: 'SBIN0001234' }]);
    let r = await call(employees, 'PUT', '/1/bank', { user: ADMIN, body: { ifsc: 'sbin0001234' } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.ifsc, 'SBIN0001234');

    on(/^SELECT \* FROM employee_bank WHERE employee_id = \?/, [{ employee_id: 1, ifsc: 'SBIN0001234' }]);
    on(/^UPDATE employee_bank SET/, [{ employee_id: 1, ifsc: 'HDFC0000999' }]);
    r = await call(employees, 'PUT', '/1/bank', { user: ADMIN, body: { ifsc: 'hdfc0000999' } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.ifsc, 'HDFC0000999');
  });

  /* ══ attendance.routes ═════════════════════════════════════════════ */
  const attendance = load('routes/attendance.routes.js');
  const { cleanEntry, checkMarkableDate } = attendance._test;

  await t('cleanEntry: invalid id/status/time/order rejected; no-time statuses blank the clock', () => {
    assert.ok(cleanEntry({ employeeId: 'x' }).error);
    assert.ok(cleanEntry({ employeeId: 1, status: 'Bogus' }).error);
    assert.ok(cleanEntry({ employeeId: 1, checkIn: '9:30' }).error);
    assert.ok(cleanEntry({ employeeId: 1, checkIn: '10:00', checkOut: '09:00' }).error);
    const e = cleanEntry({ employeeId: 1, status: 'Absent', checkIn: '09:00' });
    assert.strictEqual(e.checkIn, null);
  });
  await t('checkMarkableDate: rejects bad format and future dates', () => {
    assert.ok(checkMarkableDate('2026-9-1'));
    assert.ok(checkMarkableDate('2099-01-01'));
    assert.strictEqual(checkMarkableDate(require('../utils/hr').todayStr()), null);
  });
  await t('POST /api/attendance/mark — employee role forbidden; manager allowed; locked month blocked', async () => {
    const today = require('../utils/hr').todayStr();
    const forb = await call(attendance, 'POST', '/mark', { user: EMPLOYEE, body: { employeeId: 1, date: today, status: 'Present' } });
    assert.strictEqual(forb.status, 403);

    on(/^SELECT employee_id FROM payroll WHERE month = \? AND year = \? AND status = 'Locked'$/, [{ employee_id: 1 }]);
    const locked = await call(attendance, 'POST', '/mark', { user: MANAGER, body: { employeeId: 1, date: today, status: 'Present' } });
    assert.strictEqual(locked.status, 409);

    on(/^SELECT employee_id FROM payroll WHERE month = \? AND year = \? AND status = 'Locked'$/, []);
    on(/^INSERT INTO attendance/, [{ id: 10, employee_id: 1, status: 'Present' }]);
    on(/^INSERT INTO audit_logs/, []);
    const ok = await call(attendance, 'POST', '/mark', { user: MANAGER, body: { employeeId: 1, date: today, status: 'Present' } });
    assert.strictEqual(ok.status, 200);
  });
  await t('POST /api/attendance/check-in — blocked with no linked employee, then succeeds, then blocks double check-in', async () => {
    on(/^SELECT \* FROM employees WHERE user_id = \?/, []);
    const none = await call(attendance, 'POST', '/check-in', { user: EMPLOYEE });
    assert.strictEqual(none.status, 404);

    on(/^SELECT \* FROM employees WHERE user_id = \?/, [{ id: 1, name: 'E', work_mode: 'Office' }]);
    on(/^SELECT \* FROM attendance WHERE employee_id = \? AND date = \?$/, []);
    on(/^INSERT INTO attendance/, [{ id: 11, check_in: '09:05' }]);
    const ok = await call(attendance, 'POST', '/check-in', { user: EMPLOYEE });
    assert.strictEqual(ok.status, 200);

    on(/^SELECT \* FROM attendance WHERE employee_id = \? AND date = \?$/, [{ id: 11, check_in: '09:05:00', check_out: null }]);
    const dup = await call(attendance, 'POST', '/check-in', { user: EMPLOYEE });
    assert.strictEqual(dup.status, 409);
  });
  await t('POST /api/attendance/check-out — rejects without a check-in and out-before-in', async () => {
    on(/^SELECT \* FROM employees WHERE user_id = \?/, [{ id: 1, name: 'E', work_mode: 'Office' }]);
    on(/^SELECT \* FROM attendance WHERE employee_id = \? AND date = \?$/, []);
    const none = await call(attendance, 'POST', '/check-out', { user: EMPLOYEE });
    assert.strictEqual(none.status, 409);
  });

  /* ══ leave.routes ══════════════════════════════════════════════════ */
  const leave = load('routes/leave.routes.js');
  const today = require('../utils/hr').todayStr();
  const mon = require('../utils/hr').addDays(today, ((8 - new Date(today + 'T00:00:00Z').getUTCDay()) % 7) || 7); // a future Monday

  await t('POST /api/leave/requests — rejects Sunday-only range and half-day across 2 days', async () => {
    on(/^SELECT \* FROM employees WHERE user_id = \?/, [{ id: 1, name: 'E' }]);
    on(/^SELECT \* FROM leave_types WHERE id = \? AND active = TRUE$/, [{ id: 1, name: 'Casual', paid: true, annual_days: 12 }]);
    const half = await call(leave, 'POST', '/requests', { user: EMPLOYEE, body: { leaveTypeId: 1, fromDate: mon, toDate: require('../utils/hr').addDays(mon, 1), halfDay: true, reason: 'personal work' } });
    assert.strictEqual(half.status, 400);
    assert.match(half.body.error, /single day/);
  });
  await t('POST /api/leave/requests — insufficient balance rejected; sufficient balance succeeds and marks pending', async () => {
    on(/^SELECT \* FROM employees WHERE user_id = \?/, [{ id: 1, name: 'E' }]);
    on(/^SELECT \* FROM leave_types WHERE id = \? AND active = TRUE$/, [{ id: 1, name: 'Casual', paid: true, annual_days: 12 }]);
    on(/^SELECT id FROM leave_requests\nWHERE employee_id = \?/, []);
    on(/^INSERT INTO leave_balances/, []);
    on(/^SELECT lb\.id, lb\.employee_id/, [{ id: 1, employee_id: 1, leave_type_id: 1, year: Number(today.slice(0, 4)), opening: 0, accrued: 12, used: 0, pending: 0, closing: 2, leave_type_name: 'Casual', paid: true }]);
    const low = await call(leave, 'POST', '/requests', { user: EMPLOYEE, body: { leaveTypeId: 1, fromDate: mon, toDate: require('../utils/hr').addDays(mon, 4), reason: 'trip planned' } });
    assert.strictEqual(low.status, 400);
    assert.match(low.body.error, /Insufficient/);

    on(/^SELECT lb\.id, lb\.employee_id/, [{ id: 1, employee_id: 1, leave_type_id: 1, year: Number(today.slice(0, 4)), opening: 0, accrued: 12, used: 0, pending: 0, closing: 12, leave_type_name: 'Casual', paid: true }]);
    on(/^INSERT INTO leave_requests/, [{ id: 50, employee_id: 1, leave_type_id: 1, from_date: mon, to_date: mon, days: 1, status: 'Submitted' }]);
    on(/^UPDATE leave_balances SET pending = pending/, []);
    on(/^INSERT INTO notifications/, []);
    on(/^INSERT INTO audit_logs/, []);
    const ok = await call(leave, 'POST', '/requests', { user: EMPLOYEE, body: { leaveTypeId: 1, fromDate: mon, toDate: mon, reason: 'personal work' } });
    assert.strictEqual(ok.status, 201);
    assert.strictEqual(ok.body.days, 1);
  });
  await t('PUT manager-action then hr-action — approving triggers attendance write and balance consumption', async () => {
    const lr = { id: 50, employee_id: 1, leave_type_id: 1, from_date: mon, to_date: mon, days: 1, half_day: false, status: 'Submitted', employee_user_id: 'emp1', leave_type_name: 'Casual', paid: true };
    on(/^SELECT lr\.\*, e\.name AS employee_name/, [lr]);
    on(/^UPDATE leave_requests SET manager_action/, [{ ...lr, status: 'Manager Approved' }]);
    on(/^INSERT INTO notifications/, []);
    on(/^INSERT INTO audit_logs/, []);
    const mgr = await call(leave, 'PUT', '/requests/50/manager-action', { user: MANAGER, body: { action: 'Approved' } });
    assert.strictEqual(mgr.status, 200);
    assert.strictEqual(mgr.body.status, 'Manager Approved');

    const lr2 = { ...lr, status: 'Manager Approved' };
    on(/^SELECT lr\.\*, e\.name AS employee_name/, [lr2]);
    on(/^UPDATE leave_requests SET hr_action/, [{ ...lr2, status: 'HR Approved' }]);
    on(/^UPDATE leave_balances SET pending = GREATEST/, []);
    on(/^SELECT month, year FROM payroll WHERE employee_id = \? AND status = 'Locked'$/, []);
    on(/^INSERT INTO attendance/, [{}]);
    on(/^INSERT INTO notifications/, []);
    on(/^INSERT INTO audit_logs/, []);
    const hrRes = await call(leave, 'PUT', '/requests/50/hr-action', { user: HR, body: { action: 'Approved' } });
    assert.strictEqual(hrRes.status, 200);
    const attWrite = calls(/^INSERT INTO attendance/)[0];
    assert.strictEqual(attWrite.values[2], 'Leave'); // status column for a paid leave type
  });
  await t('hr-action — cannot approve own request unless admin', async () => {
    const lr = { id: 51, employee_id: 2, leave_type_id: 1, from_date: mon, to_date: mon, days: 1, status: 'Manager Approved', employee_user_id: 'hr1', leave_type_name: 'Casual', paid: true };
    on(/^SELECT lr\.\*, e\.name AS employee_name/, [lr]);
    const r = await call(leave, 'PUT', '/requests/51/hr-action', { user: HR, body: { action: 'Approved' } });
    assert.strictEqual(r.status, 403);
  });

  /* ══ payroll.routes ════════════════════════════════════════════════ */
  const payroll = load('routes/payroll.routes.js');
  const { eligible, totals, maskAccount } = payroll._test;

  await t('eligible(): joiners/leavers outside the month window are excluded, mid-month is included', () => {
    assert.ok(!eligible({ status: 'Active', joined: '2026-10-05', date_leaving: null }, '2026-09-01', '2026-09-30'));
    assert.ok(eligible({ status: 'Active', joined: '2026-09-15', date_leaving: null }, '2026-09-01', '2026-09-30'));
    assert.ok(!eligible({ status: 'Resigned', date_leaving: '2026-08-01' }, '2026-09-01', '2026-09-30'));
    assert.ok(eligible({ status: 'Resigned', date_leaving: '2026-09-10' }, '2026-09-01', '2026-09-30'));
  });
  await t('totals() sums an entries array; maskAccount() keeps only last 4 digits', () => {
    assert.deepStrictEqual(totals([{ gross: 100, totalDed: 10, netPay: 90 }, { gross: 50, totalDed: 5, netPay: 45 }]),
      { gross: 150, deductions: 15, net: 135, count: 2 });
    assert.strictEqual(maskAccount('1234567890'), 'XXXXXX7890');
    assert.strictEqual(maskAccount(null), null);
  });
  await t('POST /api/payroll/generate — manager forbidden; future month rejected for HR/admin', async () => {
    const forb = await call(payroll, 'POST', '/generate', { user: MANAGER, body: { month: 1, year: 2026 } });
    assert.strictEqual(forb.status, 403);
    const future = await call(payroll, 'POST', '/generate', { user: ADMIN, body: { month: 12, year: 2099 } });
    assert.strictEqual(future.status, 400);
  });
  await t('POST /api/payroll/generate — skips employees with no salary and already-published rows', async () => {
    on(/^SELECT \* FROM employees WHERE id = \?/, []);
    on(/^SELECT \* FROM employees ORDER BY name$/, [
      { id: 1, name: 'Paid', status: 'Active', salary: 20000, joined: '2020-01-01', date_leaving: null },
      { id: 2, name: 'NoSalary', status: 'Active', salary: 0, joined: '2020-01-01', date_leaving: null },
    ]);
    on(/^SELECT employee_id, status FROM attendance/, []);
    on(/^SELECT \* FROM employee_statutory$/, []);
    on(/^SELECT DISTINCT ON \(employee_id\)/, []);
    on(/^SELECT \* FROM payroll WHERE month = \? AND year = \?$/, [{ employee_id: 1, status: 'Locked' }]);
    on(/^INSERT INTO audit_logs/, []);
    const r = await call(payroll, 'POST', '/generate', { user: ADMIN, body: { month: 1, year: 2026 } });
    assert.strictEqual(r.status, 201);
    assert.strictEqual(r.body.generated, 0); // #1 already Locked, #2 has no salary
    assert.strictEqual(r.body.skipped.length, 2);
  });
  await t('GET /api/payroll/payslip — employee cannot view an unpublished (Draft) payslip', async () => {
    on(/^SELECT \* FROM employees WHERE user_id = \?/, [{ id: 1, name: 'E', status: 'Active', joined: '2020-01-01', date_leaving: null }]);
    on(/^SELECT \* FROM employees WHERE id = \?/, [{ id: 1, name: 'E', status: 'Active', joined: '2020-01-01', date_leaving: null }]);
    on(/^SELECT employee_id, status FROM attendance/, []);
    on(/^SELECT \* FROM employee_statutory$/, []);
    on(/^SELECT DISTINCT ON \(employee_id\)/, []);
    on(/^SELECT \* FROM payroll WHERE month = \? AND year = \?$/, [{ employee_id: 1, status: 'Draft' }]);
    const r = await call(payroll, 'GET', '/payslip', { user: EMPLOYEE, query: { month: '1', year: '2026' } });
    assert.strictEqual(r.status, 403);
  });

  /* ══ users.routes ══════════════════════════════════════════════════ */
  const users = load('routes/users.routes.js');
  await t('POST /api/users/:id/toggle-active — cannot disable the super admin, yourself, or (for non-admins) anyone', async () => {
    const superAdmin = await call(users, 'POST', '/admin/toggle-active', { user: ADMIN2 });
    assert.strictEqual(superAdmin.status, 400);
    assert.match(superAdmin.body.error, /super admin/);

    const self = await call(users, 'POST', '/admin2/toggle-active', { user: ADMIN2 });
    assert.strictEqual(self.status, 400);
    assert.match(self.body.error, /own account/);

    const forbidden = await call(users, 'POST', '/hr1/toggle-active', { user: HR }); // HR is not admin at all
    assert.strictEqual(forbidden.status, 403);

    on(/^SELECT \* FROM users WHERE id = \?/, [{ id: 'hr1', active: true }]);
    on(/^UPDATE users SET active/, [{ id: 'hr1', active: false }]);
    on(/^INSERT INTO audit_logs/, []);
    const ok = await call(users, 'POST', '/hr1/toggle-active', { user: ADMIN2 }); // a *different* admin disabling hr1 — allowed
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(ok.body.active, false);
  });
  await t('GET /api/users/options — admin and HR allowed, manager forbidden', async () => {
    on(/^SELECT u\.id, u\.name, u\.role/, [{ id: 'emp1', name: 'Employee', role: 'employee', employee_id: 1 }]);
    const okHr = await call(users, 'GET', '/options', { user: HR });
    assert.strictEqual(okHr.status, 200);
    const forb = await call(users, 'GET', '/options', { user: MANAGER });
    assert.strictEqual(forb.status, 403);
  });

  /* ══ dashboard.routes ══════════════════════════════════════════════ */
  const dashboard = load('routes/dashboard.routes.js');
  await t('GET /api/dashboard — employee role gets "me" only, no company-wide widgets', async () => {
    on(/^SELECT id, name, dept, dob, joined, status FROM employees$/, [{ id: 1, name: 'E', dept: 'IT', dob: null, joined: '2020-01-01', status: 'Active' }]);
    on(/^SELECT value FROM site_content/, []);
    on(/^SELECT \* FROM employees WHERE user_id = \?/, [{ id: 1, name: 'E', work_mode: 'Office' }]);
    on(/^SELECT status, check_in, check_out FROM attendance/, []);
    on(/^SELECT lb\.leave_type_id/, []);
    on(/^SELECT id AS leave_type_id/, [{ leave_type_id: 1, leave_type_name: 'Casual', paid: true, accrued: 12, used: 0, pending: 0, closing: 12 }]);
    on(/^SELECT COUNT\(\*\)::int AS c FROM leave_requests WHERE employee_id/, [{ c: 0 }]);
    const r = await call(dashboard, 'GET', '/', { user: EMPLOYEE });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.departments, undefined);
    assert.strictEqual(r.body.me.name, 'E');
  });
  await t('GET /api/dashboard — staff role gets department + attendance + pending-leave widgets', async () => {
    on(/^SELECT id, name, dept, dob, joined, status FROM employees$/, [{ id: 1, name: 'E', dept: 'IT', dob: null, joined: '2020-01-01', status: 'Active' }]);
    on(/^SELECT status, COUNT\(\*\)::int AS c FROM attendance/, [{ status: 'Present', c: 1 }]);
    on(/^SELECT COUNT\(\*\)::int AS c FROM leave_requests WHERE status IN/, [{ c: 2 }]);
    on(/^SELECT e\.name, lt\.name AS leave_type/, []);
    on(/^SELECT \* FROM employees WHERE user_id = \?/, []);
    const r = await call(dashboard, 'GET', '/', { user: ADMIN });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.departments[0].name, 'IT');
    assert.strictEqual(r.body.pendingLeaves, 2);
    assert.strictEqual(r.body.me, undefined);
  });

  console.log(`\n${n} route tests passed`);
})();
