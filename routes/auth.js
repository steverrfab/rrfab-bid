'use strict';
const express = require('express');
const jwt = require('jsonwebtoken');
const router = express.Router();
const db = require('../db');
const { signToken, hashPassword, verifyPassword, generateToken } = require('../lib/auth');
const { sendAccessRequestNotification } = require('../lib/email');

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
  res.json({ token, user: { id: user.id, email: user.email, name: user.name, role: user.role, tracker_role: user.tracker_role } });
});

// GET /api/auth/me  — returns current user from DB (requires bearer token)
router.get('/me', (req, res) => {
  if (!req.user || !req.user.userId) return res.status(401).json({ error: 'not authenticated' });
  const user = db.prepare('SELECT id, email, name, role, active, tracker_role FROM users WHERE id = ?').get(req.user.userId);
  if (!user || !user.active) return res.status(401).json({ error: 'user not found or inactive' });
  res.json(user);
});

// POST /api/auth/tracker-sso: mint a short-lived signed token that logs the
// user into the Project Tracker. The tracker verifies it with the shared
// TRACKER_KEY secret already used by the won-jobs feed.
router.post('/tracker-sso', (req, res) => {
  if (!req.user || !req.user.userId) return res.status(401).json({ error: 'not authenticated' });
  const user = db.prepare('SELECT email, name, active, tracker_role FROM users WHERE id = ?').get(req.user.userId);
  if (!user || !user.active || !user.tracker_role || user.tracker_role === 'none') {
    return res.status(403).json({ error: 'No tracker access' });
  }
  const base = process.env.TRACKER_API_URL;
  const key = process.env.TRACKER_KEY;
  if (!base || !key) return res.status(503).json({ error: 'Tracker connection not configured' });
  const token = jwt.sign(
    { email: user.email, name: user.name, tracker_role: user.tracker_role, purpose: 'tracker-sso' },
    key,
    { algorithm: 'HS256', expiresIn: 120 }
  );
  res.json({ url: `${base.replace(/\/$/, '')}/sso?token=${token}` });
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

  const user = db.prepare('SELECT id, email, name, role, tracker_role FROM users WHERE id = ?').get(invite.user_id);
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

// POST /api/auth/request-access  { name, email }  — public
router.post('/request-access', async (req, res) => {
  const { name, email } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required.' });
  if (!email || !email.trim()) return res.status(400).json({ error: 'Email is required.' });
  const nameClean  = name.trim();
  const emailClean = email.trim().toLowerCase();

  // Reject if already an active user
  const existing = db.prepare("SELECT active FROM users WHERE email = ? COLLATE NOCASE").get(emailClean);
  if (existing && existing.active) {
    return res.status(409).json({ error: 'That email already has an active account. Try logging in.' });
  }
  // Reject duplicate pending request
  const dup = db.prepare("SELECT id FROM access_requests WHERE email = ? COLLATE NOCASE AND status = 'pending'").get(emailClean);
  if (dup) {
    return res.status(409).json({ error: 'A request from that email is already pending review.' });
  }

  db.prepare("INSERT INTO access_requests (name, email) VALUES (?, ?)").run(nameClean, emailClean);
  const request = { name: nameClean, email: emailClean };
  sendAccessRequestNotification(request).catch(err => console.error('[auth] access request email failed:', err.message));
  res.json({ ok: true });
});

module.exports = router;
