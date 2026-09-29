'use strict';
const { sql } = require('../db');

// Cache permissions per user for the duration of a request
async function getUserPermissions(userId, role) {
  // Admin has all permissions
  if (role === 'admin') return null; // null = all allowed

  // Fetch explicit per-user grants from DB
  const rows = await sql`
    SELECT permission_id, granted FROM user_permissions WHERE user_id = ${userId}
  `;
  const granted = new Set(rows.filter(r => r.granted).map(r => r.permission_id));
  const denied  = new Set(rows.filter(r => !r.granted).map(r => r.permission_id));

  // Default permissions by role
  const defaults = {
    manager: new Set([
      'employee.view', 'attendance.view', 'attendance.create',
      'leave.view', 'leave.approve', 'reports.view'
    ]),
    hr: new Set([
      'employee.view', 'employee.create', 'employee.edit', 'employee.import',
      'attendance.view', 'attendance.create', 'attendance.edit',
      'salary.view', 'payroll.view', 'payroll.create',
      'leave.view', 'leave.approve', 'reports.view', 'reports.export',
      'users.view'
    ]),
    employee: new Set([
      'employee.view', 'attendance.view', 'salary.view',
      'leave.view', 'leave.apply'
    ])
  };

  const base = defaults[role] || new Set();
  // Merge: add explicit grants, remove explicit denials
  for (const p of granted) base.add(p);
  for (const p of denied)  base.delete(p);
  return base;
}

function requirePermission(permission) {
  return async (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    try {
      const perms = await getUserPermissions(req.user.id, req.user.role);
      if (perms === null) return next(); // admin
      if (perms.has(permission)) return next();
      return res.status(403).json({ error: `Permission denied: ${permission}` });
    } catch (err) {
      console.error('Permission check error:', err);
      return res.status(500).json({ error: 'Server error' });
    }
  };
}

module.exports = { requirePermission, getUserPermissions };
