'use strict';
const { sql } = require('../db');

// What a Manager must NOT see (they get the working profile, not pay/personal data).
const MANAGER_HIDDEN = [
  'salary', 'dob', 'personal_email', 'marital_status', 'blood_group',
  'perm_address', 'curr_address', 'emg_name', 'emg_relation', 'emg_phone',
];

// The employees row linked to a login (employees.user_id), or null.
async function employeeForUser(userId) {
  if (!userId) return null;
  const rows = await sql`SELECT * FROM employees WHERE user_id = ${userId} LIMIT 1`;
  return rows[0] || null;
}

// Strip fields a given role is not allowed to see.
function stripForRole(emp, role) {
  if (!emp || role === 'admin' || role === 'hr') return emp;
  if (role === 'manager') {
    const out = { ...emp };
    for (const k of MANAGER_HIDDEN) delete out[k];
    return out;
  }
  return emp; // employee role only ever receives its own record
}

/**
 * Resolve which employee id a request may act on.
 *  - admin / hr / manager: whatever was requested (or null = "everyone")
 *  - employee: only their own linked record
 * Returns { id, own?, error?, status? }
 */
async function scopeEmployeeId(req, requested) {
  if (['admin', 'hr', 'manager'].includes(req.user.role)) {
    return { id: requested === undefined || requested === null || requested === '' ? null : Number(requested) };
  }
  const own = await employeeForUser(req.user.id);
  if (!own) {
    return { id: null, status: 404, error: 'No employee record is linked to your login. Please ask HR to link it.' };
  }
  if (requested !== undefined && requested !== null && requested !== '' && Number(requested) !== own.id) {
    return { id: null, status: 403, error: 'You can only access your own records' };
  }
  return { id: own.id, own };
}

function parseIntId(raw) {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// Friendly message for common Postgres constraint errors, or null.
function pgMessage(err) {
  const c = err && err.code;
  const where = `${(err && err.constraint) || ''} ${(err && err.message) || ''}`;
  if (c === '23505') {
    if (/emp_code/.test(where)) return 'That employee code is already in use';
    if (/user_id/.test(where)) return 'That login user is already linked to another employee';
    return 'A record with the same unique value already exists';
  }
  if (c === '23503') return 'This record is referenced by other data and cannot be changed/removed';
  if (c === '23514') return 'A value is outside the allowed range/list';
  return null;
}

module.exports = { MANAGER_HIDDEN, employeeForUser, stripForRole, scopeEmployeeId, parseIntId, pgMessage };
