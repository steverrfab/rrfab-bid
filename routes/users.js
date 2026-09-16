'use strict';
const express = require('express');
const router = express.Router();
const db = require('../db');
const { generateToken, requireAdmin } = require('../lib/auth');
const { sendInvite, sendPasswordReset } = require('../lib/email');
const { PAGES, cleanIncoming, effectivePages } = require('../lib/access');

// All user management routes require admin role
router.use(requireAdmin);

const FRONTEND_URL = () => process.env.FRONTEND_URL || 'https://bid.rrfabrication.org';

// Tracker access levels. These map to the Project Tracker's own roles;
// 'none' means no tracker access. Enforced in code, not a DB CHECK.
const TRACKER_ROLES = ['none', 'shop', 'pm', 'accounting', 'admin'];

// GET /api/users
router.get('/', (req, res) => {
  const users = db.prepare(`
    SELECT
      u.id, u.email, u.name, u.role, u.active, u.created_at, u.tracker_role, u.page_access,
      (SELECT used_at  FROM invites WHERE user_id = u.id ORDER BY created_at DESC LIMIT 1) as invite_used_at,
      (SELECT expires_at FROM invites WHERE user_id = u.id AND used_at IS NULL
         AND expires_at > datetime('now') ORDER BY created_at DESC LIMIT 1) as pending_invite_expires
    FROM users u ORDER BY u.created_at ASC
  `).all();
  // page_access: the stored custom list (null = role defaults).
  // pages: what the person actually sees. PAGES: the list the screen offers.
  for (const u of users) {
    let custom = null;
    try { custom = u.page_access ? JSON.parse(u.page_access) : null; } catch { custom = null; }
    u.pages = effectivePages(u);
    u.page_access = Array.isArray(custom) ? custom : null;
  }
  res.json({ users, pages: PAGES });
});

// POST /api/users/invite  { email, name?, role }
router.post('/invite', async (req, res) => {
  const { email, name = '', role = 'estimator' } = req.body || {};
  if (!email || !email.trim()) return res.status(400).json({ error: 'Email is required.' });
  const allowedInviteRoles = req.user.role === 'superadmin' ? ['superadmin', 'admin', 'estimator'] : ['estimator'];
  if (!allowedInviteRoles.includes(role)) {
    return res.status(403).json({ error: 'You do not have permission to invite with that role.' });
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
    db.prepare("UPDATE users SET role = ?, name = ?, password_hash = NULL, active = 0, page_access = CASE WHEN role = ? THEN page_access ELSE NULL END WHERE id = ?")
      .run(role, name.trim() || user.name, role, user.id);
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

// PUT /api/users/:id  { role?, active?, password?, name?, phone?, tracker_role? }
router.put('/:id', (req, res) => {
  const { signToken, hashPassword } = require('../lib/auth');
  const id = Number(req.params.id);
  const { role, active, password, name, phone, tracker_role } = req.body || {};
  const hasPageAccess = Object.prototype.hasOwnProperty.call(req.body || {}, 'page_access');
  let pageAccess;

  // Users can only update their own profile (name, phone)
  // Admins can manage roles/active status
  // Superadmin can reset passwords

  if (id === req.user.userId && active === 0) {
    return res.status(400).json({ error: 'You cannot deactivate your own account.' });
  }
  if (role !== undefined) {
    const allowed = req.user.role === 'superadmin'
      ? ['superadmin', 'admin', 'estimator']
      : ['estimator'];
    if (!allowed.includes(role)) {
      return res.status(403).json({ error: 'You do not have permission to assign that role.' });
    }
  }
  if (tracker_role !== undefined) {
    if (!TRACKER_ROLES.includes(tracker_role)) {
      return res.status(400).json({ error: 'Invalid tracker role.' });
    }
    if (tracker_role === 'admin' && req.user.role !== 'superadmin') {
      return res.status(403).json({ error: 'Only superadmin can grant tracker admin access.' });
    }
  }

  // Page access: which menu pages this person sees. null = role defaults.
  // Superadmin always sees everything. An admin may set it for estimators; the
  // superadmin may set it for admins and estimators. Nobody edits their own.
  if (hasPageAccess) {
    pageAccess = cleanIncoming(req.body.page_access);
    if (pageAccess === undefined) {
      return res.status(400).json({ error: 'Invalid page list.' });
    }
    if (id === req.user.userId) {
      return res.status(400).json({ error: 'You cannot change your own page access.' });
    }
    const target = db.prepare('SELECT role FROM users WHERE id = ?').get(id);
    if (!target) return res.status(404).json({ error: 'User not found.' });
    if (target.role === 'superadmin') {
      return res.status(400).json({ error: 'A superadmin always sees every page.' });
    }
    if (target.role !== 'estimator' && req.user.role !== 'superadmin') {
      return res.status(403).json({ error: 'Only the superadmin can change an admin\'s page access.' });
    }
  }

  // Only superadmin can reset passwords
  if (password !== undefined) {
    if (req.user.role !== 'superadmin') {
      return res.status(403).json({ error: 'Only superadmin can reset passwords.' });
    }
    if (!password || password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    }
  }

  const sets = [];
  const params = [];
  if (role !== undefined)   { sets.push('role = ?');   params.push(role); }
  if (active !== undefined) { sets.push('active = ?'); params.push(active ? 1 : 0); }
  if (password !== undefined) { sets.push('password_hash = ?'); params.push(hashPassword(password)); }
  if (name !== undefined)   { sets.push('name = ?');   params.push(name ? name.trim() : null); }
  if (phone !== undefined)  { sets.push('phone = ?');  params.push(phone ? phone.trim() : null); }
  if (tracker_role !== undefined) { sets.push('tracker_role = ?'); params.push(tracker_role); }
  if (hasPageAccess) { sets.push('page_access = ?'); params.push(pageAccess === null ? null : JSON.stringify(pageAccess)); }
  // A role change puts page access back to the new role's defaults, so a
  // custom list written for one role never carries over to another.
  if (role !== undefined && !hasPageAccess) {
    const cur = db.prepare('SELECT role FROM users WHERE id = ?').get(id);
    if (cur && cur.role !== role) sets.push('page_access = NULL');
  }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update.' });

  params.push(id);
  db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  res.json({ ok: true });
});

// POST /api/users/:id/reset-password  — email the user a link to choose a new password
// Reuses the invite mechanism: a fresh 48-hour token that lands on the same
// "set your password" screen. The account is NOT deactivated and the current
// password keeps working until the link is used, so a reset that is never
// clicked locks nobody out. Admins may reset estimators; superadmin anyone.
router.post('/:id/reset-password', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const user = db.prepare('SELECT id, email, name, role FROM users WHERE id = ?').get(id);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    if (req.user.role !== 'superadmin' && user.role !== 'estimator') {
      return res.status(403).json({ error: 'Only superadmin can reset an admin\'s password.' });
    }
    db.prepare("UPDATE invites SET used_at = datetime('now') WHERE user_id = ? AND used_at IS NULL").run(user.id);
    const token = generateToken();
    const expires = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
    db.prepare('INSERT INTO invites (user_id, token, expires_at) VALUES (?, ?, ?)').run(user.id, token, expires);
    const resetUrl = `${FRONTEND_URL()}/#/invite/${token}`;
    const emailResult = await sendPasswordReset(user.email, user.name || user.email, resetUrl);
    console.log(`[users] password reset link for ${user.email} — ${resetUrl}`);
    res.json({ ok: true, resetUrl, emailResult });
  } catch (err) {
    console.error('[users] reset-password failed:', err);
    res.status(500).json({ error: err.message || 'Reset failed.' });
  }
});

// GET /api/users/access-requests  — list pending access requests
router.get('/access-requests', (req, res) => {
  const requests = db.prepare(
    "SELECT * FROM access_requests WHERE status = 'pending' ORDER BY created_at DESC"
  ).all();
  res.json({ requests });
});

// POST /api/users/access-requests/:id/approve  { role }  — approve and send invite
router.post('/access-requests/:id/approve', async (req, res) => {
  const id = Number(req.params.id);
  const role = req.body?.role || 'estimator';
  if (!['admin', 'estimator'].includes(role)) return res.status(400).json({ error: 'Invalid role.' });

  const accessReq = db.prepare("SELECT * FROM access_requests WHERE id = ? AND status = 'pending'").get(id);
  if (!accessReq) return res.status(404).json({ error: 'Request not found or already handled.' });

  const emailClean = accessReq.email.toLowerCase();

  // Create or refresh user (same logic as /invite)
  let user = db.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE').get(emailClean);
  if (user && user.password_hash && user.active) {
    // Already active — mark approved and return
    db.prepare("UPDATE access_requests SET status = 'approved' WHERE id = ?").run(id);
    return res.json({ ok: true, note: 'User already active.' });
  }
  if (!user) {
    db.prepare("INSERT INTO users (email, name, role, active) VALUES (?, ?, ?, 0)")
      .run(emailClean, accessReq.name, role);
    user = db.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE').get(emailClean);
  } else {
    db.prepare("UPDATE users SET role = ?, name = ?, password_hash = NULL, active = 0, page_access = CASE WHEN role = ? THEN page_access ELSE NULL END WHERE id = ?")
      .run(role, accessReq.name || user.name, role, user.id);
  }

  db.prepare("UPDATE invites SET used_at = datetime('now') WHERE user_id = ? AND used_at IS NULL").run(user.id);
  const token = generateToken();
  const expires = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
  db.prepare('INSERT INTO invites (user_id, token, expires_at) VALUES (?, ?, ?)').run(user.id, token, expires);

  const inviteUrl = FRONTEND_URL() + '/#/invite/' + token;
  await sendInvite(emailClean, accessReq.name || emailClean, inviteUrl);

  db.prepare("UPDATE access_requests SET status = 'approved' WHERE id = ?").run(id);
  const requests = db.prepare("SELECT * FROM access_requests WHERE status = 'pending' ORDER BY created_at DESC").all();
  res.json({ ok: true, requests });
});

// DELETE /api/users/access-requests/:id  — silently deny
router.delete('/access-requests/:id', (req, res) => {
  const id = Number(req.params.id);
  db.prepare("UPDATE access_requests SET status = 'denied' WHERE id = ?").run(id);
  const requests = db.prepare("SELECT * FROM access_requests WHERE status = 'pending' ORDER BY created_at DESC").all();
  res.json({ ok: true, requests });
});

module.exports = router;
