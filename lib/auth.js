'use strict';
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-railway-env-vars';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'rrfab';

function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '30d' });
}

function verifyPassword(input) {
  return String(input || '') === ADMIN_PASSWORD;
}

function requireAuth(req, res, next) {
  if (req.method === 'OPTIONS') return next();
  // Public endpoints
  if (req.path === '/api/health' || req.path === '/api/auth/login' || req.path === '/') return next();
  // Allow unauth template download (used by the frontend before login screen too)
  if (req.path === '/api/template/takeoff') return next();

  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return res.status(401).json({ error: 'auth required' });
  try {
    req.user = jwt.verify(m[1], JWT_SECRET);
    next();
  } catch (err) {
    res.status(401).json({ error: 'invalid token' });
  }
}

module.exports = { signToken, verifyPassword, requireAuth };
