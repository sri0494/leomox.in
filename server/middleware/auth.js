// ============================================================================
// middleware/auth.js — JWT verification (from httpOnly cookie) + role checks
// ============================================================================
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
    console.error('Missing JWT_SECRET environment variable. Set a long random string in .env.');
    process.exit(1);
}

const COOKIE_NAME = 'leomox_session';
const TOKEN_TTL = '8h';

function signToken(user) {
    return jwt.sign(
        { id: user.id, role: user.role, name: user.name },
        JWT_SECRET,
        { expiresIn: TOKEN_TTL }
    );
}

function setSessionCookie(res, token) {
    res.cookie(COOKIE_NAME, token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 8 * 60 * 60 * 1000 // 8 hours
    });
}

function clearSessionCookie(res) {
    res.clearCookie(COOKIE_NAME);
}

// Populates req.user if a valid session cookie is present; does NOT reject
// the request if absent (use requireAuth for that). Handy for endpoints that
// behave differently for logged-in vs anonymous users.
function attachUser(req, res, next) {
    const token = req.cookies?.[COOKIE_NAME];
    if (token) {
        try {
            req.user = jwt.verify(token, JWT_SECRET);
        } catch (e) {
            req.user = null;
        }
    }
    next();
}

function requireAuth(req, res, next) {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    next();
}

function requireRole(...roles) {
    return (req, res, next) => {
        if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
        if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
        next();
    };
}

module.exports = {
    signToken,
    setSessionCookie,
    clearSessionCookie,
    attachUser,
    requireAuth,
    requireRole,
    COOKIE_NAME
};
