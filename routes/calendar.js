'use strict';
// Bid Calendar (v2). Its own list of bid invites: an estimator adds one when a
// GC email or bid board invite comes in, then links it to an estimate when the
// work starts. One estimate per calendar bid (each GC gets its own number).
//
// A linked estimate's Bid Due Date follows the calendar: saving a date here
// writes it to the estimate too. Nothing else on the estimate is touched,
// except by Start bid / Copy for this GC, which create a new estimate.
const express = require('express');
const router = express.Router();
const db = require('../db');
const { isoDate, isoTime, dueAt } = require('../lib/bid_due');

function isAdminish(role) {
  return role === 'admin' || role === 'superadmin';
}

const SOURCES = ['Email', 'BuildingConnected', 'PlanHub', 'Procore', 'Phone', 'Other'];
// "Start working by" is a lead time off the due date, not a typed date.
const LEAD_DAYS = [1, 2, 5];
const DEFAULT_LEAD = 2;

// The day to start work on a bid: its due date less its lead time.
function startDay(dueDate, leadDays) {
  const d = isoDate(dueDate);
  if (!d) return '';
  const [y, m, day] = d.split('-').map(Number);
  const at = new Date(Date.UTC(y, m - 1, day - (Number(leadDays) || DEFAULT_LEAD)));
  return at.toISOString().slice(0, 10);
}

// Calendar row + its linked estimate (a deleted estimate counts as not linked).
const ENTRY_SELECT = `
  SELECT c.id, c.project_name, c.client_gc, c.source, c.due_date, c.due_time, c.start_lead_days,
         c.assigned_to, c.docs_url, c.notes, c.created_by, c.created_at, c.updated_at,
         u.name AS estimator_name,
         e.id AS estimate_id, e.bid_number AS estimate_bid_number, e.project_name AS estimate_project_name,
         e.client_gc AS estimate_client_gc, e.status AS estimate_status
  FROM bid_calendar c
  LEFT JOIN users u ON u.id = c.assigned_to
  LEFT JOIN estimates e ON e.id = c.estimate_id AND e.deleted_at IS NULL
`;

function shape(r) {
  const due = r.due_time ? dueAt(r.due_date, r.due_time) : null;
  return {
    id: r.id,
    project_name: r.project_name,
    client_gc: r.client_gc,
    source: r.source,
    due_date: r.due_date,
    due_time: r.due_time || '',
    start_lead_days: r.start_lead_days == null ? DEFAULT_LEAD : r.start_lead_days,
    start_date: startDay(r.due_date, r.start_lead_days),
    due_at: due ? due.toISOString() : null,
    assigned_to: r.assigned_to,
    estimator_name: r.estimator_name || '',
    docs_url: r.docs_url,
    notes: r.notes,
    estimate: r.estimate_id ? {
      id: r.estimate_id,
      bid_number: r.estimate_bid_number,
      project_name: r.estimate_project_name,
      client_gc: r.estimate_client_gc,
      status: r.estimate_status,
    } : null,
  };
}

function loadEntry(id) {
  const r = db.prepare(ENTRY_SELECT + ' WHERE c.id = ? AND c.deleted_at IS NULL').get(id);
  return r ? shape(r) : null;
}

// Estimators may only touch calendar bids assigned to them.
function canTouch(req, entry) {
  return isAdminish(req.user.role) || entry.assigned_to === req.user.userId;
}

function getEntryOr404(req, res) {
  const entry = loadEntry(Number(req.params.id));
  if (!entry) { res.status(404).json({ error: 'That calendar bid no longer exists.' }); return null; }
  if (!canTouch(req, entry)) { res.status(403).json({ error: 'Access denied.' }); return null; }
  return entry;
}

// Clean the editable fields out of a request body. Returns { fields, error }.
function readFields(req, body, { partial }) {
  const out = {};
  const has = k => Object.prototype.hasOwnProperty.call(body, k);
  const str = v => String(v == null ? '' : v).trim();
  if (!partial || has('project_name')) out.project_name = str(body.project_name);
  if (!partial || has('client_gc')) out.client_gc = str(body.client_gc);
  if (!partial || has('source')) out.source = SOURCES.includes(str(body.source)) ? str(body.source) : '';
  if (!partial || has('due_date')) out.due_date = isoDate(body.due_date);
  if (!partial || has('due_time')) out.due_time = isoTime(body.due_time) || null;
  if (!partial || has('start_lead_days')) {
    const n = Number(body.start_lead_days);
    out.start_lead_days = LEAD_DAYS.includes(n) ? n : DEFAULT_LEAD;
  }
  if (!partial || has('docs_url')) out.docs_url = str(body.docs_url).slice(0, 2000);
  if (!partial || has('notes')) out.notes = str(body.notes).slice(0, 5000);
  if (has('assigned_to') && isAdminish(req.user.role)) {
    const uid = Number(body.assigned_to) || null;
    if (uid && !db.prepare('SELECT 1 FROM users WHERE id = ?').get(uid)) return { error: 'That estimator does not exist.' };
    out.assigned_to = uid;
  } else if (!partial) {
    out.assigned_to = req.user.userId;
  }
  const missing = [];
  if ('project_name' in out && !out.project_name) missing.push('Project');
  if ('due_date' in out && !out.due_date) missing.push('Bid due date');
  if (missing.length) return { error: 'Fill in before saving: ' + missing.join(', ') + '.' };
  return { fields: out };
}

// The linked estimate's Bid Due Date follows the calendar.
function syncEstimateDate(entryId) {
  const c = db.prepare('SELECT estimate_id, due_date FROM bid_calendar WHERE id = ?').get(entryId);
  if (!c || !c.estimate_id) return;
  db.prepare('UPDATE estimates SET bid_date = ? WHERE id = ? AND deleted_at IS NULL AND (bid_date IS NULL OR bid_date != ?)')
    .run(c.due_date, c.estimate_id, c.due_date);
}

// Estimate is free to link: exists, visible to this user, not already on
// another calendar bid, and an ordinary bid (not an alternate or CO pricing).
function checkLinkable(req, estimateId, entryId) {
  const est = db.prepare('SELECT id, created_by, deleted_at, is_alternate, change_order_id, confirmed FROM estimates WHERE id = ?').get(estimateId);
  if (!est || est.deleted_at || est.is_alternate || est.change_order_id || !est.confirmed) return 'That estimate was not found.';
  if (!isAdminish(req.user.role) && est.created_by !== req.user.userId) return 'That estimate is not yours.';
  const other = db.prepare('SELECT id FROM bid_calendar WHERE estimate_id = ? AND deleted_at IS NULL AND id != ?').get(estimateId, entryId || 0);
  if (other) return 'That estimate is already linked to another calendar bid.';
  return null;
}

// GET /api/calendar?from=YYYY-MM-DD&to=YYYY-MM-DD&user=<id|all>
// Calendar bids due, or to be started, inside the window. Estimators always get
// their own; admins may pass user=<id> or user=all. Also returns the unlinked
// Draft estimates the Link picker offers.
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

  const rows = db.prepare(ENTRY_SELECT + `
    WHERE c.deleted_at IS NULL
      AND ((c.due_date BETWEEN ? AND ?)
           OR (date(c.due_date, '-' || IFNULL(c.start_lead_days, 2) || ' days') BETWEEN ? AND ?))
      ${userFilter ? 'AND c.assigned_to = ?' : ''}
    ORDER BY c.due_date, IFNULL(c.due_time, '99:99'), c.id
  `).all(from, to, from, to, ...(userFilter ? [userFilter] : []));

  const users = admin
    ? db.prepare("SELECT id, name, email FROM users WHERE active = 1 ORDER BY name ASC").all()
    : [];

  // Draft estimates not linked to any calendar bid, for the Link picker. The
  // popup narrows these to the calendar bid's own estimator.
  const drafts = db.prepare(`
    SELECT e.id, e.bid_number, e.project_name, e.client_gc, e.created_by
    FROM estimates e
    WHERE e.deleted_at IS NULL AND e.confirmed = 1 AND e.is_alternate = 0 AND e.change_order_id IS NULL
      AND (e.bid_type = 'real' OR e.bid_type IS NULL)
      AND e.status = 'Draft'
      AND NOT EXISTS (SELECT 1 FROM bid_calendar c WHERE c.estimate_id = e.id AND c.deleted_at IS NULL)
      ${admin ? '' : 'AND e.created_by = ?'}
    ORDER BY e.id DESC
  `).all(...(admin ? [] : [req.user.userId]));

  res.json({ entries: rows.map(shape), users, drafts, viewing: userFilter, is_admin: admin, sources: SOURCES, lead_days: LEAD_DAYS, default_lead: DEFAULT_LEAD });
});

// GET /api/calendar/entry/:id  - one calendar bid (opens it from a link).
router.get('/entry/:id', (req, res) => {
  const entry = getEntryOr404(req, res);
  if (entry) res.json(entry);
});

// GET /api/calendar/siblings/:id
// Other calendar bids for the same estimator that already have an estimate.
// The popup keeps the ones that look like the same job and offers to copy that
// estimate, so a job bid to more than one GC is priced from the first one.
router.get('/siblings/:id', (req, res) => {
  const entry = getEntryOr404(req, res);
  if (!entry) return;
  const rows = db.prepare(ENTRY_SELECT + `
    WHERE c.deleted_at IS NULL AND c.id != ? AND e.id IS NOT NULL
      AND ${entry.assigned_to ? 'c.assigned_to = ?' : 'c.assigned_to IS NULL'}
    ORDER BY c.due_date DESC LIMIT 200
  `).all(entry.id, ...(entry.assigned_to ? [entry.assigned_to] : []));
  res.json({ entries: rows.map(shape) });
});

// GET /api/calendar/for-estimate/:estimateId
// For the estimate's Project tab: the calendar bid it is linked to, or the
// open unlinked calendar bids of the same estimator it could be linked to.
router.get('/for-estimate/:estimateId', (req, res) => {
  const est = db.prepare('SELECT id, created_by, deleted_at FROM estimates WHERE id = ?').get(Number(req.params.estimateId));
  if (!est || est.deleted_at) return res.status(404).json({ error: 'not found' });
  if (!isAdminish(req.user.role) && est.created_by !== req.user.userId) return res.status(403).json({ error: 'Access denied.' });
  const linkedRow = db.prepare(ENTRY_SELECT + ' WHERE c.deleted_at IS NULL AND c.estimate_id = ?').get(est.id);
  if (linkedRow) return res.json({ linked: shape(linkedRow), candidates: [] });
  const today = new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 10);
  const rows = db.prepare(ENTRY_SELECT + `
    WHERE c.deleted_at IS NULL AND e.id IS NULL AND c.due_date >= ?
      AND ${est.created_by ? 'c.assigned_to = ?' : '1 = 1'}
    ORDER BY c.due_date, IFNULL(c.due_time, '99:99')
  `).all(today, ...(est.created_by ? [est.created_by] : []));
  res.json({ linked: null, candidates: rows.map(shape) });
});

// GET /api/calendar/due-soon
// The signed-in user's calendar bids with a due time inside the next 24 hours
// that are still being quoted. Polled by the browser for the desktop
// notification, so it also honors push_24h.
router.get('/due-soon', (req, res) => {
  const s = db.prepare('SELECT push_24h FROM user_reminder_settings WHERE user_id = ?').get(req.user.userId);
  if (s && !s.push_24h) return res.json({ now: new Date().toISOString(), bids: [] });
  const rows = db.prepare(ENTRY_SELECT + `
    WHERE c.deleted_at IS NULL AND c.assigned_to = ? AND c.due_time IS NOT NULL AND c.due_time != ''
      AND (e.id IS NULL OR e.status = 'Draft')
  `).all(req.user.userId);
  const now = Date.now();
  const bids = [];
  for (const r of rows) {
    const due = dueAt(r.due_date, r.due_time);
    if (!due) continue;
    const left = due.getTime() - now;
    if (left <= 0 || left > 24 * 3600 * 1000) continue;
    bids.push({
      id: r.estimate_id || null, calendar_id: r.id, bid_number: r.estimate_bid_number || '',
      project_name: r.project_name, client_gc: r.client_gc,
      bid_date: r.due_date, bid_time: r.due_time, due_at: due.toISOString(),
      key: 'cal' + r.id + ':due24:' + due.toISOString(),
    });
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

// ---- Calendar bids: add, edit, remove, link ----
// (Kept below the fixed paths above so PUT /reminder-settings never matches PUT /:id.)

// POST /api/calendar  - add a bid invite to the calendar.
// With estimate_id it is created already linked to that estimate, which is how
// the Project tab adds a bid that is not on the calendar yet.
router.post('/', (req, res) => {
  const { fields, error } = readFields(req, req.body || {}, { partial: false });
  if (error) return res.status(400).json({ error });
  const estimateId = Number(req.body && req.body.estimate_id) || null;
  if (estimateId) {
    const why = checkLinkable(req, estimateId, null);
    if (why) return res.status(409).json({ error: why });
    // It belongs to whoever the estimate belongs to.
    const owner = db.prepare('SELECT created_by FROM estimates WHERE id = ?').get(estimateId);
    if (owner && owner.created_by) fields.assigned_to = owner.created_by;
  }
  const info = db.prepare(`INSERT INTO bid_calendar
    (project_name, client_gc, source, due_date, due_time, start_lead_days, assigned_to, docs_url, notes, created_by)
    VALUES (@project_name, @client_gc, @source, @due_date, @due_time, @start_lead_days, @assigned_to, @docs_url, @notes, @created_by)`)
    .run({ ...fields, created_by: req.user.userId });
  const id = info.lastInsertRowid;
  if (estimateId) {
    db.prepare('UPDATE bid_calendar SET estimate_id = ? WHERE id = ?').run(estimateId, id);
    syncEstimateDate(id);
  }
  res.status(201).json(loadEntry(id));
});

// PUT /api/calendar/:id  - edit. A new due date also goes to the linked estimate.
router.put('/:id', (req, res) => {
  const entry = getEntryOr404(req, res);
  if (!entry) return;
  const { fields, error } = readFields(req, req.body || {}, { partial: true });
  if (error) return res.status(400).json({ error });
  const keys = Object.keys(fields);
  if (keys.length) {
    db.transaction(() => {
      db.prepare(`UPDATE bid_calendar SET ${keys.map(k => `${k} = @${k}`).join(', ')}, updated_at = datetime('now') WHERE id = @id`)
        .run({ ...fields, id: entry.id });
      if ('due_date' in fields) syncEstimateDate(entry.id);
    })();
  }
  res.json(loadEntry(entry.id));
});

// DELETE /api/calendar/:id  - remove from the calendar. The estimate is untouched.
router.delete('/:id', (req, res) => {
  const entry = getEntryOr404(req, res);
  if (!entry) return;
  db.prepare("UPDATE bid_calendar SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(entry.id);
  res.json({ ok: true });
});

// POST /api/calendar/:id/link { estimate_id }
router.post('/:id/link', (req, res) => {
  const entry = getEntryOr404(req, res);
  if (!entry) return;
  if (entry.estimate) return res.status(409).json({ error: 'This calendar bid already has an estimate. Unlink it first.' });
  const estimateId = Number(req.body && req.body.estimate_id);
  const why = checkLinkable(req, estimateId, entry.id);
  if (why) return res.status(409).json({ error: why });
  db.transaction(() => {
    db.prepare("UPDATE bid_calendar SET estimate_id = ?, updated_at = datetime('now') WHERE id = ?").run(estimateId, entry.id);
    syncEstimateDate(entry.id);
  })();
  res.json(loadEntry(entry.id));
});

// POST /api/calendar/:id/unlink  - the estimate itself is not changed.
router.post('/:id/unlink', (req, res) => {
  const entry = getEntryOr404(req, res);
  if (!entry) return;
  db.prepare("UPDATE bid_calendar SET estimate_id = NULL, updated_at = datetime('now') WHERE id = ?").run(entry.id);
  res.json(loadEntry(entry.id));
});

// POST /api/calendar/:id/start { job_type }
// New blank estimate with project, GC and due date filled in, owned by the
// calendar bid's estimator, and linked.
router.post('/:id/start', (req, res) => {
  const entry = getEntryOr404(req, res);
  if (!entry) return;
  if (entry.estimate) return res.status(409).json({ error: 'This calendar bid already has an estimate.' });
  const { createEstimate, nextBidNumber } = require('./estimates');
  const jobType = req.body && req.body.job_type === 'process_only' ? 'process_only' : 'full';
  const ownerId = entry.assigned_to || req.user.userId;
  const owner = db.prepare('SELECT name FROM users WHERE id = ?').get(ownerId);
  let estimateId;
  db.transaction(() => {
    estimateId = createEstimate(ownerId, owner && owner.name, {
      project_name: entry.project_name, client_gc: entry.client_gc, bid_date: entry.due_date,
      status: 'Draft', job_type: jobType,
    });
    // Numbered right away so the calendar can show it (New Estimate numbers on first save).
    db.prepare("UPDATE estimates SET bid_number = ? WHERE id = ? AND (bid_number IS NULL OR bid_number = '')").run(nextBidNumber(), estimateId);
    db.prepare("UPDATE bid_calendar SET estimate_id = ?, updated_at = datetime('now') WHERE id = ?").run(estimateId, entry.id);
  })();
  res.status(201).json({ entry: loadEntry(entry.id), estimate_id: estimateId });
});

// POST /api/calendar/:id/copy { from_estimate_id }
// "Copy for this GC": copy another GC's estimate for the same job into a new
// estimate (own bid number), set this GC and due date, and link it. The
// original estimate is not changed.
router.post('/:id/copy', (req, res) => {
  const entry = getEntryOr404(req, res);
  if (!entry) return;
  if (entry.estimate) return res.status(409).json({ error: 'This calendar bid already has an estimate.' });
  const srcId = Number(req.body && req.body.from_estimate_id);
  const src = db.prepare('SELECT * FROM estimates WHERE id = ? AND deleted_at IS NULL AND is_alternate = 0 AND change_order_id IS NULL').get(srcId);
  if (!src) return res.status(404).json({ error: 'The estimate to copy was not found.' });
  if (!isAdminish(req.user.role) && src.created_by !== req.user.userId) return res.status(403).json({ error: 'Access denied.' });
  const { copyAsNewJob } = require('./estimates');
  let estimateId;
  db.transaction(() => {
    estimateId = copyAsNewJob(src, '');
    const ownerId = entry.assigned_to || src.created_by || req.user.userId;
    db.prepare(`UPDATE estimates SET bid_date = ?, created_by = ?, status = 'Draft',
                submitted_at = NULL, won_at = NULL, bid_type = 'real', revised_from_id = NULL WHERE id = ?`)
      .run(entry.due_date, ownerId, estimateId);
    db.prepare("UPDATE estimates SET bid_date = ?, created_by = ? WHERE parent_estimate_id = ? AND is_alternate = 1")
      .run(entry.due_date, ownerId, estimateId);
    // A calendar bid carries no GC, so the copy keeps the GC it was copied from
    // until the estimator changes it on the Project tab.
    if (entry.client_gc) {
      db.prepare('UPDATE estimates SET client_gc = ? WHERE id = ? OR (parent_estimate_id = ? AND is_alternate = 1)')
        .run(entry.client_gc, estimateId, estimateId);
    }
    db.prepare("UPDATE bid_calendar SET estimate_id = ?, updated_at = datetime('now') WHERE id = ?").run(estimateId, entry.id);
  })();
  res.status(201).json({ entry: loadEntry(entry.id), estimate_id: estimateId });
});

module.exports = router;
