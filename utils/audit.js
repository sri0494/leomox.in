'use strict';
const { sql } = require('../db');

async function log(req, { action, module: mod, recordId, oldValue, newValue, reason }) {
  try {
    await sql`
      INSERT INTO audit_logs (user_id, role, action, module, record_id, old_value, new_value, reason, ip_address)
      VALUES (
        ${req.user?.id || null},
        ${req.user?.role || null},
        ${action},
        ${mod},
        ${recordId ? String(recordId) : null},
        ${oldValue ? JSON.stringify(oldValue) : null},
        ${newValue ? JSON.stringify(newValue) : null},
        ${reason || null},
        ${req.ip || null}
      )
    `;
  } catch (err) {
    console.error('Audit log error:', err);
  }
}

module.exports = { log };
