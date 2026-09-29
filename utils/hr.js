'use strict';
/**
 * Pure helpers — no database, no Express. Everything here is unit-testable.
 */
const TZ = process.env.APP_TIMEZONE || 'Asia/Kolkata';
const pad = (n) => String(n).padStart(2, '0');

/* ── Dates ─────────────────────────────────────────────────────────────── */

// Normalise anything date-like to 'YYYY-MM-DD' (or null).
// node-postgres parses a DATE column into a JS Date at *local* midnight, so
// local getters give the original calendar date back regardless of server TZ.
function toDateStr(v) {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return null;
    return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v));
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

function isValidDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

function isValidTime(s) {
  return /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(s || '');
}

// "Today" and "now" in the company timezone (Render servers run in UTC).
function todayStr(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
function nowTimeStr(now = new Date()) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now);
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}
function monthRange(year, month) {
  return { start: `${year}-${pad(month)}-01`, end: `${year}-${pad(month)}-${pad(daysInMonth(year, month))}` };
}
function isSunday(ds) {
  return new Date(ds + 'T00:00:00Z').getUTCDay() === 0;
}
function eachDate(from, to) {
  const out = [];
  const end = Date.parse(to + 'T00:00:00Z');
  for (let t = Date.parse(from + 'T00:00:00Z'); t <= end; t += 86400000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}
function addDays(ds, n) {
  return new Date(Date.parse(ds + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
}

/* ── Leave ─────────────────────────────────────────────────────────────── */

// Working days between two dates inclusive; Sundays are the weekly off.
// Half-day is only valid for a single working day.
function calcLeaveDays(from, to, halfDay) {
  const dates = eachDate(from, to).filter((d) => !isSunday(d));
  if (halfDay) return from === to && dates.length === 1 ? 0.5 : 0;
  return dates.length;
}

/* ── Payroll ───────────────────────────────────────────────────────────── */

// LOP days from attendance rows: Absent = 1, Half Day = 0.5.
function lopFromAttendance(rows) {
  let lop = 0;
  for (const r of rows || []) {
    if (r.status === 'Absent') lop += 1;
    else if (r.status === 'Half Day') lop += 0.5;
  }
  return lop;
}

// Calendar days in the month that fall outside the employment window
// (before joining / after leaving) — these are unpaid.
function daysOutsideEmployment(year, month, joined, leaving) {
  const { start, end } = monthRange(year, month);
  let outside = 0;
  const j = toDateStr(joined);
  const l = toDateStr(leaving);
  if (j && j > start) outside += eachDate(start, j > end ? end : addDays(j, -1)).length;
  if (l && l < end) outside += eachDate(l < start ? start : addDays(l, 1), end).length;
  return Math.min(outside, daysInMonth(year, month));
}

const has = (v) => v !== null && v !== undefined && String(v).trim() !== '';

/**
 * Compute one employee's payroll for a month.
 *  - employee.salary is the monthly BASIC (matches the original payslip).
 *  - If an explicit employee_salary `structure` row exists, its amounts are used.
 *  - Otherwise defaults: HRA 40%, Conveyance 5%, Medical 3%, Special 10%, LTA 5%.
 *  - Deductions follow the employee's statutory record when one exists;
 *    with no record they fall back to the original defaults (PF 12%, PT 200, TDS 5%).
 */
function computePayroll({ employee, structure, statutory, lopDays = 0, month, year }) {
  const dim = daysInMonth(year, month);
  const lop = Math.min(Math.max(Number(lopDays) || 0, 0), dim);
  const paidDays = dim - lop;
  const ratio = paidDays / dim;

  let full;
  if (structure) {
    full = {
      basic: +structure.basic || 0, hra: +structure.hra || 0, conveyance: +structure.conveyance || 0,
      medical: +structure.medical || 0, special: +structure.special || 0, other: +structure.other_earnings || 0,
    };
  } else {
    const basic = Number(employee.salary) || 0;
    full = { basic, hra: basic * 0.4, conveyance: basic * 0.05, medical: basic * 0.03, special: basic * 0.1, other: basic * 0.05 };
  }
  const earned = {};
  for (const k of Object.keys(full)) earned[k] = Math.round(full[k] * ratio);
  const gross = earned.basic + earned.hra + earned.conveyance + earned.medical + earned.special + earned.other;

  let empPf, empEsi, profTax, tds, otherDed;
  if (structure) {
    empPf = Math.round((+structure.emp_pf || 0) * ratio);
    empEsi = Math.round((+structure.emp_esi || 0) * ratio);
    profTax = Math.round(+structure.prof_tax || 0);
    tds = Math.round((+structure.tds || 0) * ratio);
    otherDed = Math.round((+structure.lwf || 0) + (+structure.other_deductions || 0));
  } else if (statutory) {
    empPf = has(statutory.pf_number) ? Math.round(earned.basic * 0.12) : 0;
    empEsi = has(statutory.esic_number) && gross <= 21000 ? Math.round(gross * 0.0075) : 0;
    profTax = statutory.pt_applicable ? 200 : 0;
    tds = statutory.tds_applicable ? Math.round(earned.basic * 0.05) : 0;
    otherDed = 0;
  } else {
    empPf = Math.round(earned.basic * 0.12);
    empEsi = 0;
    profTax = 200;
    tds = Math.round(earned.basic * 0.05);
    otherDed = 0;
  }
  if (gross === 0) { empPf = empEsi = profTax = tds = otherDed = 0; } // fully unpaid month

  const totalDed = empPf + empEsi + profTax + tds + otherDed;
  const erPf = empPf;
  const erEsi = empEsi > 0 ? Math.round(gross * 0.0325) : 0;
  const gratuity = structure ? Math.round(+structure.gratuity || 0) : Math.round(earned.basic * 0.0481);

  return {
    month, year, daysInMonth: dim, paidDays, lopDays: lop,
    basic: earned.basic, hra: earned.hra, conveyance: earned.conveyance, medical: earned.medical,
    special: earned.special, otherEarn: earned.other, gross,
    empPf, empEsi, profTax, tds, otherDed, totalDed, netPay: gross - totalDed,
    erPf, erEsi, gratuity,
  };
}

// Map a stored `payroll` row to the same camelCase shape computePayroll returns.
function rowToEntry(r) {
  const n = (v) => Number(v) || 0;
  return {
    month: r.month, year: r.year, daysInMonth: daysInMonth(r.year, r.month),
    paidDays: n(r.paid_days), lopDays: n(r.lop_days),
    basic: n(r.basic), hra: n(r.hra), conveyance: n(r.conveyance), medical: n(r.medical),
    special: n(r.special), otherEarn: n(r.other_earn), gross: n(r.gross),
    empPf: n(r.emp_pf), empEsi: n(r.emp_esi), profTax: n(r.prof_tax), tds: n(r.tds),
    otherDed: n(r.other_ded), totalDed: n(r.total_ded), netPay: n(r.net_pay),
    erPf: n(r.er_pf), erEsi: n(r.er_esi), gratuity: n(r.gratuity),
  };
}


/* ── Anniversaries (birthdays / work anniversaries) ────────────────────── */

const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

// Days from `today` until the next occurrence of the month/day of `dateStr` (0 = today).
// A 29-Feb date falls on 28-Feb in non-leap years.
function daysUntilAnniversary(dateStr, today) {
  const d = toDateStr(dateStr);
  if (!d || !isValidDate(today)) return null;
  const month = Number(d.slice(5, 7)), day = Number(d.slice(8, 10));
  const at = (y) => `${y}-${pad(month)}-${pad(month === 2 && day === 29 && !isLeap(y) ? 28 : day)}`;
  const ty = Number(today.slice(0, 4));
  let next = at(ty);
  if (next < today) next = at(ty + 1);
  return Math.round((Date.parse(next + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / 86400000);
}

/* ── Serialisation ─────────────────────────────────────────────────────── */

// JSON.stringify replacer: date-only columns become 'YYYY-MM-DD' (so
// <input type="date"> works and tables don't show ISO timestamps), while real
// timestamps (…_at columns) keep their full ISO form.
function jsonReplacer(key, value) {
  const raw = this[key];
  if (raw instanceof Date && !isNaN(raw.getTime()) && !/_at$/i.test(key)) return toDateStr(raw);
  return value;
}

module.exports = {
  TZ, toDateStr, isValidDate, isValidTime, todayStr, nowTimeStr, daysInMonth, monthRange, isSunday,
  eachDate, addDays, calcLeaveDays, lopFromAttendance, daysOutsideEmployment, computePayroll, rowToEntry, jsonReplacer, daysUntilAnniversary,
};
