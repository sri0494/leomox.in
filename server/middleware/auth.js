'use strict';
const jwt = require('jsonwebtoken');

/* Verify JWT from Authorization: Bearer <token> header */
function requireAuth(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/* Same as above, plus role check */
function requireRole(...roles) {
  return [requireAuth, (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: `Requires role: ${roles.join(' or ')}` });
    }
    next();
  }];
}

const requireAdmin   = requireRole('admin');
const requireManager = requireRole('admin', 'manager');
const requireHR      = requireRole('admin', 'manager', 'hr');
const requireAny     = [requireAuth, (req, res, next) => next()];

module.exports = { requireAuth, requireRole, requireAdmin, requireManager, requireHR, requireAny };
