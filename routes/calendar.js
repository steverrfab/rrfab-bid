'use strict';
// Bid Calendar. A read view over the estimates table plus per-user reminder
// preferences. Nothing here creates a second copy of a due date: moving a bid
// on the calendar goes through the normal PUT /api/estimates/:id.
const express = require('express');
const router = express.Router();
const db = require('../db');
const { isoDate, isoTime, dueAt } = require('../lib/bid_due');

function isAdminish(role) {
  return role === 'admin' || role === 'superadmin';
}

// GET /api/calendar?from=YYYY-MM-DD&to=YYYY-MM-DD&user=<id|all>
// Estimators always get their own bids. Admins may pass user=<id> or user=all.
router.get('/', (req, res) => {
  const from = isoDate(req.query.from) || '0000-00-00';
  const to = isoDate(req.query.to) || '9999-12-31';
  const admin = isAdminish(req.user.role);
  let userFilter = req.user.userId;
  if (admin) {
    const u = String(req.query.user || '').trim();
    if (u === 'all') userFilter = null;
    else if (u) userFilter = Number(u) || req.user.userId;
  }

  const rows = db.prepare(`
    SELECT e.id, e.bid_number, e.project_name, e.client_gc, e.bid_date, e.bid_time, e.status,
           e.created_by, e.submitted_at, u.name AS estimator_name
    FROM estimates e
    LEFT JOIN users u ON u.id = e.created_by
    WHERE e.deleted_at IS NULL AND e.confirmed = 1 AND e.is_alternate = 0 AND e.change_order_id IS NULL
      AND (e.bid_type = 'real' OR e.bid_type IS NULL)
      AND e.bid_date IS NOT NULL AND e.bid_date != ''
      ${userFilter ? 'AND e.created_by = ?' : ''}
  `).all(...(userFilter ? [userFilter] : []));

  const bids = [];
  for (const r of rows) {
    const d = isoDate(r.bid_date);
    if (!d || d < from || d > to) continue;
    const due = dueAt(r.bid_date, r.bid_time);
    bids.push({
      id: r.id,
      bid_number: r.bid_number,
      project_name: r.project_name,
      client_gc: r.client_gc,
      bid_date: d,
      bid_time: isoTime(r.bid_time),
      due_at: due ? due.toISOString() : null,
      status: r.status,
      created_by: r.created_by,
      estimator_name: r.estimator_name
    });
  }
  bids.sort((a, b) => (a.bid_date + (a.bid_time || '')).localeCompare(b.bid_date + (b.bid_time || '')));

  // Estimator list for the admin's "Showing" dropdown.
  const users = admin
    ? db.prepare("SELECT id, name, email FROM users WHERE active = 1 ORDER BY name ASC").all()
    : [];

  // Bids still being quoted (Draft) that are not on the calendar yet, for the
  // "Add to calendar" picker. Anything already on the calendar is changed by
  // clicking it there or on its Project tab, so it is not offered here.
  const pickable = db.prepare(`
    SELECT e.id, e.bid_number, e.project_name, e.client_gc, e.bid_date, e.bid_time, e.status, e.created_by, u.name AS estimator_name
    FROM estimates e
    LEFT JOIN users u ON u.id = e.created_by
    WHERE e.deleted_at IS NULL AND e.confirmed = 1 AND e.is_alternate = 0 AND e.change_order_id IS NULL
      AND (e.bid_type = 'real' OR e.bid_type IS NULL)
      AND e.status = 'Draft'
      ${userFilter ? 'AND e.created_by = ?' : ''}
    ORDER BY e.id DESC
  `).all(...(userFilter ? [userFilter] : [])).map(r => ({ ...r, bid_date: isoDate(r.bid_date), bid_time: isoTime(r.bid_time) }));
  const unscheduled = pickable.filter(b => !b.bid_date || !b.bid_time);

  res.json({ bids, users, unscheduled, viewing: userFilter, is_admin: admin });
});

// GET /api/calendar/due-soon
// The signed-in user's own Draft bids due within the next 24 hours. Polled by
// the browser for the desktop notification, so it also honors push_24h.
router.get('/due-soon', (req, res) => {
  const s = db.prepare('SELECT push_24h FROM user_reminder_settings WHERE user_id = ?').get(req.user.userId);
  if (s && !s.push_24h) return res.json({ now: new Date().toISOString(), bids: [] });
  const rows = db.prepare(`
    SELECT id, bid_number, project_name, client_gc, bid_date, bid_time, status
    FROM estimates
    WHERE deleted_at IS NULL AND confirmed = 1 AND is_alternate = 0 AND change_order_id IS NULL
      AND (bid_type = 'real' OR bid_type IS NULL) AND status = 'Draft'
      AND created_by = ? AND bid_date IS NOT NULL AND bid_date != '' AND bid_time IS NOT NULL AND bid_time != ''
  `).all(req.user.userId);
  const now = Date.now();
  const bids = [];
  for (const r of rows) {
    const due = dueAt(r.bid_date, r.bid_time);
    if (!due) continue;
    const left = due.getTime() - now;
    if (left <= 0 || left > 24 * 3600 * 1000) continue;
    bids.push({ id: r.id, bid_number: r.bid_number, project_name: r.project_name, client_gc: r.client_gc,
      bid_date: isoDate(r.bid_date), bid_time: isoTime(r.bid_time), due_at: due.toISOString(),
      key: r.id + ':due24:' + due.toISOString() });
  }
  res.json({ now: new Date(now).toISOString(), bids });
});

// ---- Reminder settings (per user) ----
const DEFAULTS = { email_24h: 1, push_24h: 1, morning_of: 0, admin_copy: 0 };

router.get('/reminder-settings', (req, res) => {
  const row = db.prepare('SELECT email_24h, push_24h, morning_of, admin_copy FROM user_reminder_settings WHERE user_id = ?').get(req.user.userId);
  res.json({ ...DEFAULTS, ...(row || {}), is_admin: isAdminish(req.user.role) });
});

router.put('/reminder-settings', (req, res) => {
  const b = req.body || {};
  const cur = { ...DEFAULTS, ...(db.prepare('SELECT email_24h, push_24h, morning_of, admin_copy FROM user_reminder_settings WHERE user_id = ?').get(req.user.userId) || {}) };
  for (const k of Object.keys(DEFAULTS)) {
    if (Object.prototype.hasOwnProperty.call(b, k)) cur[k] = b[k] ? 1 : 0;
  }
  if (!isAdminish(req.user.role)) cur.admin_copy = 0;
  db.prepare(`
    INSERT INTO user_reminder_settings (user_id, email_24h, push_24h, morning_of, admin_copy, updated_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET email_24h = excluded.email_24h, push_24h = excluded.push_24h,
      morning_of = excluded.morning_of, admin_copy = excluded.admin_copy, updated_at = excluded.updated_at
  `).run(req.user.userId, cur.email_24h, cur.push_24h, cur.morning_of, cur.admin_copy);
  res.json({ ...cur, is_admin: isAdminish(req.user.role) });
});

module.exports = router;
