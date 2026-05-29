'use strict';
const express = require('express');
const router = express.Router();
const db = require('../db');
const { generateToken, requireAdmin } = require('../lib/auth');
const { sendInvite } = require('../lib/email');

// All user management routes require admin role
router.use(requireAdmin);

const FRONTEND_URL = () => process.env.FRONTEND_URL || 'https://bid.rrfabrication.org';

// GET /api/users
router.get('/', (req, res) => {
  const users = db.prepare(`
    SELECT
      u.id, u.email, u.name, u.role, u.active, u.created_at,
      (SELECT used_at  FROM invites WHERE user_id = u.id ORDER BY created_at DESC LIMIT 1) as invite_used_at,
      (SELECT expires_at FROM invites WHERE user_id = u.id AND used_at IS NULL
         AND expires_at > datetime('now') ORDER BY created_at DESC LIMIT 1) as pending_invite_expires
    FROM users u ORDER BY u.created_at ASC
  `).all();
  res.json({ users });
});

// POST /api/users/invite  { email, name?, role }
router.post('/invite', async (req, res) => {
  const { email, name = '', role = 'estimator' } = req.body || {};
  if (!email || !email.trim()) return res.status(400).json({ error: 'Email is required.' });
  if (!['admin', 'estimator'].includes(role)) {
    return res.status(400).json({ error: 'Role must be admin or estimator.' });
  }
  const emailClean = email.trim().toLowerCase();

  // Check if they already have a full account
  let user = db.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE').get(emailClean);
  if (user && user.password_hash && user.active) {
    return res.status(409).json({ error: 'That email already has an active account.' });
  }

  if (!user) {
    db.prepare("INSERT INTO users (email, name, role, active) VALUES (?, ?, ?, 0)")
      .run(emailClean, name.trim(), role);
    user = db.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE').get(emailClean);
  } else {
    // Re-invite: refresh role/name, clear old password so they must reset
    db.prepare("UPDATE users SET role = ?, name = ?, password_hash = NULL, active = 0 WHERE id = ?")
      .run(role, name.trim() || user.name, user.id);
  }

  // Expire any open invites
  db.prepare("UPDATE invites SET used_at = datetime('now') WHERE user_id = ? AND used_at IS NULL")
    .run(user.id);

  // New 48-hour invite
  const token = generateToken();
  const expires = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
  db.prepare("INSERT INTO invites (user_id, token, expires_at) VALUES (?, ?, ?)")
    .run(user.id, token, expires);

  const inviteUrl = `${FRONTEND_URL()}/#/invite/${token}`;
  const emailResult = await sendInvite(emailClean, name.trim() || emailClean, inviteUrl);

  console.log(`[users] invite sent to ${emailClean} — ${inviteUrl}`);
  res.json({ ok: true, inviteUrl, emailResult });
});

// PUT /api/users/:id  { role?, active? }
router.put('/:id', (req, res) => {
  const id = Number(req.params.id);
  const { role, active } = req.body || {};

  if (id === req.user.userId && active === 0) {
    return res.status(400).json({ error: 'You cannot deactivate your own account.' });
  }
  if (role !== undefined && !['admin', 'estimator'].includes(role)) {
    return res.status(400).json({ error: 'Role must be admin or estimator.' });
  }

  const sets = [];
  const params = [];
  if (role !== undefined)   { sets.push('role = ?');   params.push(role); }
  if (active !== undefined) { sets.push('active = ?'); params.push(active ? 1 : 0); }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update.' });

  params.push(id);
  db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  res.json({ ok: true });
});

module.exports = router;
