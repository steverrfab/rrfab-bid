'use strict';
const express = require('express');
const router = express.Router();
const db = require('../db');
const { signToken, hashPassword, verifyPassword, generateToken } = require('../lib/auth');

// POST /api/auth/login  { email, password }
router.post('/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password required.' });

  const user = db.prepare(
    "SELECT * FROM users WHERE email = ? COLLATE NOCASE AND active = 1"
  ).get(email);
  if (!user || !user.password_hash || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid email or password.' });
  }

  const token = signToken({ userId: user.id, email: user.email, name: user.name, role: user.role });
  res.json({ token, user: { id: user.id, email: user.email, name: user.name, role: user.role } });
});

// GET /api/auth/me  — returns current user from DB (requires bearer token)
router.get('/me', (req, res) => {
  if (!req.user || !req.user.userId) return res.status(401).json({ error: 'not authenticated' });
  const user = db.prepare('SELECT id, email, name, role, active FROM users WHERE id = ?').get(req.user.userId);
  if (!user || !user.active) return res.status(401).json({ error: 'user not found or inactive' });
  res.json(user);
});

// GET /api/auth/invite/:token  — validate token, return email (public)
router.get('/invite/:token', (req, res) => {
  const invite = db.prepare(`
    SELECT i.id, u.email, u.name FROM invites i
    JOIN users u ON u.id = i.user_id
    WHERE i.token = ? AND i.used_at IS NULL AND i.expires_at > datetime('now')
  `).get(req.params.token);
  if (!invite) return res.status(404).json({ error: 'This invite link is invalid or has expired.' });
  res.json({ email: invite.email, name: invite.name });
});

// POST /api/auth/invite/:token/accept  — set name + password, activate account (public)
router.post('/invite/:token/accept', (req, res) => {
  const { name, password } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required.' });
  if (!password || password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });

  const invite = db.prepare(`
    SELECT i.id, i.user_id FROM invites i
    WHERE i.token = ? AND i.used_at IS NULL AND i.expires_at > datetime('now')
  `).get(req.params.token);
  if (!invite) return res.status(404).json({ error: 'This invite link is invalid or has expired.' });

  db.prepare("UPDATE users SET name = ?, password_hash = ?, active = 1 WHERE id = ?")
    .run(name.trim(), hashPassword(password), invite.user_id);
  db.prepare("UPDATE invites SET used_at = datetime('now') WHERE id = ?")
    .run(invite.id);

  const user = db.prepare('SELECT id, email, name, role FROM users WHERE id = ?').get(invite.user_id);
  const token = signToken({ userId: user.id, email: user.email, name: user.name, role: user.role });
  res.json({ token, user });
});

// POST /api/auth/change-password  — authenticated user changes their own password
router.post('/change-password', (req, res) => {
  if (!req.user || !req.user.userId) return res.status(401).json({ error: 'not authenticated' });
  const { currentPassword, newPassword } = req.body || {};
  if (!newPassword || newPassword.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters.' });
  }

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.userId);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  if (user.password_hash && !verifyPassword(currentPassword, user.password_hash)) {
    return res.status(401).json({ error: 'Current password is incorrect.' });
  }

  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
    .run(hashPassword(newPassword), user.id);
  res.json({ ok: true });
});

module.exports = router;
