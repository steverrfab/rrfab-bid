'use strict';
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-railway-env-vars';

function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '30d' });
}

// password_hash stored as "salt:hash" (hex, scrypt)
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  try {
    const [salt, hash] = String(stored).split(':');
    const check = crypto.scryptSync(String(password), salt, 64).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(check, 'hex'));
  } catch {
    return false;
  }
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Paths that don't require a bearer token.
// Invite paths are public so uninvited users can set their password.
function isPublicPath(path) {
  if (['/api/health', '/api/auth/login', '/api/auth/request-access', '/', '/api/template/takeoff'].includes(path)) return true;
  if (path.startsWith('/api/auth/invite/')) return true;
  return false;
}

function requireAuth(req, res, next) {
  if (req.method === 'OPTIONS') return next();
  if (isPublicPath(req.path)) return next();

  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return res.status(401).json({ error: 'auth required' });
  try {
    req.user = jwt.verify(m[1], JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'invalid token' });
  }
}

function requireAdmin(req, res, next) {
  if (!req.user || (req.user.role !== 'admin' && req.user.role !== 'superadmin')) {
    return res.status(403).json({ error: 'admin access required' });
  }
  next();
}

module.exports = { signToken, hashPassword, verifyPassword, generateToken, requireAuth, requireAdmin };
