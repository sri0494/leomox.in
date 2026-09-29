'use strict';
const assert = require('assert');
const hr = require('../utils/hr');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('  ok', name); };

t('toDateStr handles Date/string/null', () => {
  assert.strictEqual(hr.toDateStr(new Date(2026, 8, 27)), '2026-09-27');
  assert.strictEqual(hr.toDateStr('2026-09-27T00:00:00.000Z'), '2026-09-27');
  assert.strictEqual(hr.toDateStr(null), null);
  assert.strictEqual(hr.toDateStr('garbage'), null);
});
t('isValidDate rejects impossible dates', () => {
  assert.ok(hr.isValidDate('2026-02-28'));
  assert.ok(!hr.isValidDate('2026-02-30'));
  assert.ok(!hr.isValidDate('2026-13-01'));
  assert.ok(!hr.isValidDate('26-01-01'));
  assert.ok(hr.isValidDate('2028-02-29'));   // leap
  assert.ok(!hr.isValidDate('2027-02-29'));
});
t('isValidTime', () => {
  assert.ok(hr.isValidTime('09:30')); assert.ok(hr.isValidTime('23:59:59'));
  assert.ok(!hr.isValidTime('24:00')); assert.ok(!hr.isValidTime('9:30')); assert.ok(!hr.isValidTime(''));
});
t('todayStr/nowTimeStr use company TZ, not server TZ', () => {
  // 2026-09-27 20:00 UTC == 2026-09-28 01:30 IST  (the exact window where UTC date is wrong)
  const inst = new Date('2026-09-27T20:00:00Z');
  assert.strictEqual(hr.todayStr(inst), '2026-09-28');
  assert.strictEqual(hr.nowTimeStr(inst), '01:30');
  // midnight IST must be 00:xx, never 24:xx
  assert.strictEqual(hr.nowTimeStr(new Date('2026-09-27T18:35:00Z')), '00:05');
});
t('daysInMonth incl. leap year', () => {
  assert.strictEqual(hr.daysInMonth(2026, 9), 30);
  assert.strictEqual(hr.daysInMonth(2028, 2), 29);
  assert.strictEqual(hr.daysInMonth(2027, 2), 28);
  assert.strictEqual(hr.daysInMonth(2026, 12), 31);
});
t('calcLeaveDays skips Sundays; half-day rules', () => {
  // Mon 2026-09-28 .. Sun 2026-10-04 => 6 working days
  assert.strictEqual(hr.calcLeaveDays('2026-09-28', '2026-10-04', false), 6);
  assert.strictEqual(hr.calcLeaveDays('2026-09-28', '2026-09-28', true), 0.5);
  assert.strictEqual(hr.calcLeaveDays('2026-09-28', '2026-09-29', true), 0);     // half-day over 2 days invalid
  assert.strictEqual(hr.calcLeaveDays('2026-10-04', '2026-10-04', false), 0);    // a lone Sunday
  assert.strictEqual(hr.calcLeaveDays('2026-10-04', '2026-10-04', true), 0);
});
t('payroll default matches the ORIGINAL payslip numbers (basic 30000)', () => {
  const p = hr.computePayroll({ employee: { salary: 30000 }, month: 9, year: 2026, lopDays: 0 });
  assert.strictEqual(p.hra, 12000); assert.strictEqual(p.conveyance, 1500);
  assert.strictEqual(p.medical, 900); assert.strictEqual(p.special, 3000); assert.strictEqual(p.otherEarn, 1500);
  assert.strictEqual(p.gross, 48900);
  assert.strictEqual(p.empPf, 3600); assert.strictEqual(p.profTax, 200); assert.strictEqual(p.tds, 1500);
  assert.strictEqual(p.totalDed, 5300); assert.strictEqual(p.netPay, 43600);
  assert.strictEqual(p.paidDays, 30);
});
t('LOP prorates earnings and paid days', () => {
  const p = hr.computePayroll({ employee: { salary: 30000 }, month: 9, year: 2026, lopDays: 3 });
  assert.strictEqual(p.paidDays, 27); assert.strictEqual(p.lopDays, 3);
  assert.strictEqual(p.basic, 27000);              // 30000 * 27/30
  assert.strictEqual(p.netPay, p.gross - p.totalDed);
  assert.ok(p.netPay < 43600);
});
t('LOP clamped to month length; fully-unpaid month has zero deductions (no negative net)', () => {
  const p = hr.computePayroll({ employee: { salary: 30000 }, month: 9, year: 2026, lopDays: 99 });
  assert.strictEqual(p.lopDays, 30); assert.strictEqual(p.gross, 0);
  assert.strictEqual(p.totalDed, 0); assert.strictEqual(p.netPay, 0);
});
t('statutory record drives deductions', () => {
  const emp = { salary: 20000 };
  const none = hr.computePayroll({ employee: emp, statutory: { pf_number: '', esic_number: '', pt_applicable: false, tds_applicable: false }, month: 9, year: 2026 });
  assert.strictEqual(none.totalDed, 0);
  const full = hr.computePayroll({ employee: emp, statutory: { pf_number: 'AP/123', esic_number: '', pt_applicable: true, tds_applicable: false }, month: 9, year: 2026 });
  assert.strictEqual(full.empPf, 2400); assert.strictEqual(full.profTax, 200); assert.strictEqual(full.tds, 0);
});
t('ESIC only below the 21,000 gross ceiling', () => {
  const st = { pf_number: '', esic_number: '1234567890', pt_applicable: false, tds_applicable: false };
  const low = hr.computePayroll({ employee: { salary: 10000 }, statutory: st, month: 9, year: 2026 });   // gross 16300
  assert.strictEqual(low.empEsi, Math.round(16300 * 0.0075));
  const high = hr.computePayroll({ employee: { salary: 30000 }, statutory: st, month: 9, year: 2026 });  // gross 48900
  assert.strictEqual(high.empEsi, 0);
});
t('explicit salary structure overrides defaults', () => {
  const s = { basic: 25000, hra: 10000, conveyance: 1600, medical: 1250, special: 2000, other_earnings: 0, emp_pf: 1800, emp_esi: 0, prof_tax: 200, tds: 500, lwf: 0, other_deductions: 100, gratuity: 1200 };
  const p = hr.computePayroll({ employee: { salary: 1 }, structure: s, month: 9, year: 2026 });
  assert.strictEqual(p.gross, 39850); assert.strictEqual(p.totalDed, 2600); assert.strictEqual(p.netPay, 37250);
});
t('daysOutsideEmployment: mid-month joiner / leaver', () => {
  assert.strictEqual(hr.daysOutsideEmployment(2026, 9, '2026-09-21', null), 20);   // joined 21st => 1..20 unpaid
  assert.strictEqual(hr.daysOutsideEmployment(2026, 9, '2026-01-01', null), 0);
  assert.strictEqual(hr.daysOutsideEmployment(2026, 9, null, '2026-09-10'), 20);   // left 10th => 11..30 unpaid
  assert.strictEqual(hr.daysOutsideEmployment(2026, 9, '2026-10-05', null), 30);   // joins next month
  assert.strictEqual(hr.daysOutsideEmployment(2026, 9, null, '2026-08-31'), 30);   // left last month
  assert.strictEqual(hr.daysOutsideEmployment(2026, 9, new Date(2026, 8, 21), null), 20);
});
t('lopFromAttendance', () => {
  assert.strictEqual(hr.lopFromAttendance([{ status: 'Absent' }, { status: 'Half Day' }, { status: 'Present' }, { status: 'Leave' }]), 1.5);
});
t('jsonReplacer: date columns -> YYYY-MM-DD, *_at timestamps untouched', () => {
  const out = JSON.parse(JSON.stringify({ joined: new Date(2026, 8, 27), created_at: new Date('2026-09-27T10:00:00Z'), nested: [{ dob: new Date(1995, 0, 5) }] }, hr.jsonReplacer));
  assert.strictEqual(out.joined, '2026-09-27');
  assert.strictEqual(out.created_at, '2026-09-27T10:00:00.000Z');
  assert.strictEqual(out.nested[0].dob, '1995-01-05');
});
t('rowToEntry mirrors computePayroll shape', () => {
  const c = hr.computePayroll({ employee: { salary: 30000 }, month: 9, year: 2026 });
  const r = hr.rowToEntry({ month: 9, year: 2026, paid_days: '30.0', lop_days: '0.0', basic: '30000', hra: '12000', conveyance: '1500', medical: '900', special: '3000', other_earn: '1500', gross: '48900', emp_pf: '3600', emp_esi: '0', prof_tax: '200', tds: '1500', other_ded: '0', total_ded: '5300', net_pay: '43600', er_pf: '3600', er_esi: '0', gratuity: '1443' });
  assert.deepStrictEqual(Object.keys(r).sort(), Object.keys(c).sort());
  assert.strictEqual(r.netPay, 43600);
});
t('daysUntilAnniversary: today, later this year, year wrap, leap day', () => {
  assert.strictEqual(hr.daysUntilAnniversary('1995-09-28', '2026-09-28'), 0);
  assert.strictEqual(hr.daysUntilAnniversary('1995-10-05', '2026-09-28'), 7);
  assert.strictEqual(hr.daysUntilAnniversary('1995-09-27', '2026-09-28'), 364);   // just passed -> next year
  assert.strictEqual(hr.daysUntilAnniversary('1995-01-03', '2026-12-30'), 4);     // wraps the new year
  assert.strictEqual(hr.daysUntilAnniversary('2000-02-29', '2027-02-27'), 1);     // non-leap year -> 28 Feb
  assert.strictEqual(hr.daysUntilAnniversary('2000-02-29', '2028-02-28'), 1);     // leap year -> real 29 Feb
  assert.strictEqual(hr.daysUntilAnniversary(new Date(1995, 9, 5), '2026-09-28'), 7);
  assert.strictEqual(hr.daysUntilAnniversary(null, '2026-09-28'), null);
});
console.log(`\n${n} tests passed`);
