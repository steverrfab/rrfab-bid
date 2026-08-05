'use strict';
const express = require('express');
const router = express.Router();
const db = require('../db');

// Local copies, deliberately not imported from routes/estimates.js so that this
// feature cannot affect existing estimate behavior. Kept tiny on purpose.
function isAdminish(role) {
  return role === 'admin' || role === 'superadmin';
}

const STATUSES = ['Draft', 'Submitted', 'Approved', 'Rejected'];

// The markup cascade, identical to the estimator and the approved mockup:
// cost -> +overhead -> +contingency -> +profit -> +CGL = sell before tax -> +tax = total
function calc(co, lines) {
  const cost = (lines || []).reduce((s, l) => s + (+l.qty || 0) * (+l.unit_cost || 0), 0);
  const oh   = cost * (+co.oh_rate || 0);
  const a1   = cost + oh;
  const cont = a1 * (+co.contingency_rate || 0);
  const a2   = a1 + cont;
  const prof = a2 * (+co.profit_rate || 0);
  const a3   = a2 + prof;
  const cgl  = a3 * (+co.cgl_rate || 0);
  const sell = a3 + cgl;
  const tax  = co.tax_mode === 'none' ? 0 : sell * (+co.sales_tax_rate || 0);
  const total = sell + tax;
  const gp = sell - cost;
  return {
    cost, oh, cont, prof, cgl, sell, tax, total, gp,
    margin: sell ? gp / sell : 0,
    markupPct: cost ? gp / cost : 0
  };
}

// A change order's parent is always an estimates row. parent_type is 'job' when
// that estimate is Won and carries a job number, otherwise 'bid'. Because it is
// the same row either way, a CO written against an open bid picks up the job
// number automatically once the bid is marked Won.
function parentTypeFor(est) {
  const hasJob = est.status === 'Won' && est.job_number != null && String(est.job_number).trim() !== '';
  return hasJob ? 'job' : 'bid';
}

function loadParent(estimateId) {
  return db.prepare(
    `SELECT id, project_name, job_number, bid_number, client_gc, status, created_by,
            oh_rate, contingency_rate, profit_rate, cgl_rate, sales_tax_rate, tax_mode
       FROM estimates
      WHERE id = ? AND deleted_at IS NULL`
  ).get(estimateId);
}

// Estimators may only see change orders hanging off their own estimates, or off
// legacy estimates that have no owner. Admins and superadmins see everything.
function canReach(user, est) {
  if (!user) return false;
  if (isAdminish(user.role)) return true;
  if (!est) return false;
  return est.created_by === null || est.created_by === user.userId;
}

function linesFor(coId) {
  return db.prepare(
    'SELECT * FROM change_order_lines WHERE change_order_id = ? ORDER BY position, id'
  ).all(coId);
}

function label(co, est) {
  const n = 'CO-' + String(co.seq).padStart(3, '0');
  if (co.parent_type === 'job') return ((est && est.job_number) || '') + ' ' + n;
  return 'Bid ' + ((est && est.bid_number) || '') + ' ' + n;
}

function hydrate(co) {
  const est = loadParent(co.estimate_id);
  const lines = linesFor(co.id);
  return {
    ...co,
    label: label(co, est),
    parent: est ? {
      id: est.id,
      project_name: est.project_name,
      job_number: est.job_number,
      bid_number: est.bid_number,
      client_gc: est.client_gc,
      status: est.status
    } : null,
    lines,
    computed: calc(co, lines)
  };
}

// The five fields the approved mockup marks with an asterisk. Enforced on create
// and on update, so a change order cannot be saved into an incomplete state.
function missingRequired(body) {
  const missing = [];
  if (!body.estimate_id) missing.push('estimate_id');
  if (!String(body.title || '').trim()) missing.push('title');
  if (!String(body.reason || '').trim()) missing.push('reason');
  if (!String(body.requested_by || '').trim()) missing.push('requested_by');
  if (!String(body.scope || '').trim()) missing.push('scope');
  return missing;
}

// ---- TARGETS ----
// Everything a change order can be attached to: Won jobs first, then open bids.
router.get('/targets', (req, res) => {
  let rows = db.prepare(
    `SELECT id, project_name, job_number, bid_number, client_gc, status, created_by,
            oh_rate, contingency_rate, profit_rate, cgl_rate, sales_tax_rate, tax_mode
       FROM estimates
      WHERE deleted_at IS NULL AND is_alternate = 0
      ORDER BY COALESCE(job_number, bid_number)`
  ).all();

  if (!isAdminish(req.user.role)) {
    rows = rows.filter(r => r.created_by === null || r.created_by === req.user.userId);
  }

  res.json(rows.map(r => ({
    id: r.id,
    parent_type: parentTypeFor(r),
    project_name: r.project_name,
    job_number: r.job_number,
    bid_number: r.bid_number,
    client_gc: r.client_gc,
    status: r.status,
    rates: {
      oh_rate: r.oh_rate,
      contingency_rate: r.contingency_rate,
      profit_rate: r.profit_rate,
      cgl_rate: r.cgl_rate,
      sales_tax_rate: r.sales_tax_rate,
      tax_mode: r.tax_mode
    }
  })));
});

// ---- LIST ----
router.get('/', (req, res) => {
  const all = db.prepare(
    'SELECT * FROM change_orders WHERE deleted_at IS NULL ORDER BY estimate_id, seq'
  ).all();

  const out = [];
  for (const co of all) {
    const est = loadParent(co.estimate_id);
    if (!canReach(req.user, est)) continue;
    if (req.query.status && co.status !== req.query.status) continue;
    if (req.query.estimate_id && co.estimate_id !== Number(req.query.estimate_id)) continue;
    out.push(hydrate(co));
  }
  res.json(out);
});

// ---- READ ONE ----
router.get('/:id', (req, res) => {
  const co = db.prepare('SELECT * FROM change_orders WHERE id = ? AND deleted_at IS NULL').get(Number(req.params.id));
  if (!co) return res.status(404).json({ error: 'not found' });
  const est = loadParent(co.estimate_id);
  if (!canReach(req.user, est)) return res.status(403).json({ error: 'Access denied.' });
  res.json(hydrate(co));
});

// ---- CREATE ----
router.post('/', (req, res) => {
  const b = req.body || {};
  const missing = missingRequired(b);
  if (missing.length) return res.status(400).json({ error: 'missing required fields', fields: missing });

  const est = loadParent(Number(b.estimate_id));
  if (!est) return res.status(404).json({ error: 'parent estimate not found' });
  if (!canReach(req.user, est)) return res.status(403).json({ error: 'Access denied.' });

  const pricing = b.pricing_mode === 'estimator' ? 'estimator' : 'quick';
  const seqRow = db.prepare(
    'SELECT COALESCE(MAX(seq), 0) AS m FROM change_orders WHERE estimate_id = ?'
  ).get(est.id);

  // Rates are snapshotted from the parent at create time so a change order keeps
  // the pricing it was written under if the parent estimate is later re-rated.
  const info = db.prepare(
    `INSERT INTO change_orders
       (estimate_id, parent_type, seq, title, reason, requested_by, scope,
        pricing_mode, status, oh_rate, contingency_rate, profit_rate, cgl_rate,
        sales_tax_rate, tax_mode, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    est.id,
    parentTypeFor(est),
    seqRow.m + 1,
    String(b.title).trim(),
    String(b.reason).trim(),
    String(b.requested_by).trim(),
    String(b.scope).trim(),
    pricing,
    'Draft',
    b.oh_rate != null ? +b.oh_rate : (+est.oh_rate || 0),
    b.contingency_rate != null ? +b.contingency_rate : (+est.contingency_rate || 0),
    b.profit_rate != null ? +b.profit_rate : (+est.profit_rate || 0),
    b.cgl_rate != null ? +b.cgl_rate : (+est.cgl_rate || 0),
    b.sales_tax_rate != null ? +b.sales_tax_rate : (+est.sales_tax_rate || 0),
    b.tax_mode || est.tax_mode || 'full',
    req.user.userId
  );

  const co = db.prepare('SELECT * FROM change_orders WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json(hydrate(co));
});

// ---- UPDATE ----
router.put('/:id', (req, res) => {
  const id = Number(req.params.id);
  const co = db.prepare('SELECT * FROM change_orders WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!co) return res.status(404).json({ error: 'not found' });
  const est = loadParent(co.estimate_id);
  if (!canReach(req.user, est)) return res.status(403).json({ error: 'Access denied.' });

  const b = req.body || {};
  const merged = {
    estimate_id: co.estimate_id,
    title: b.title != null ? b.title : co.title,
    reason: b.reason != null ? b.reason : co.reason,
    requested_by: b.requested_by != null ? b.requested_by : co.requested_by,
    scope: b.scope != null ? b.scope : co.scope
  };
  const missing = missingRequired(merged);
  if (missing.length) return res.status(400).json({ error: 'missing required fields', fields: missing });

  const status = b.status != null ? String(b.status) : co.status;
  if (!STATUSES.includes(status)) {
    return res.status(400).json({ error: 'invalid status', allowed: STATUSES });
  }
  const pricing = b.pricing_mode != null
    ? (b.pricing_mode === 'estimator' ? 'estimator' : 'quick')
    : co.pricing_mode;

  const num = (incoming, current) => (incoming != null ? +incoming : current);

  db.prepare(
    `UPDATE change_orders
        SET title = ?, reason = ?, requested_by = ?, scope = ?,
            pricing_mode = ?, status = ?,
            oh_rate = ?, contingency_rate = ?, profit_rate = ?, cgl_rate = ?,
            sales_tax_rate = ?, tax_mode = ?,
            updated_at = datetime('now')
      WHERE id = ?`
  ).run(
    String(merged.title).trim(),
    String(merged.reason).trim(),
    String(merged.requested_by).trim(),
    String(merged.scope).trim(),
    pricing,
    status,
    num(b.oh_rate, co.oh_rate),
    num(b.contingency_rate, co.contingency_rate),
    num(b.profit_rate, co.profit_rate),
    num(b.cgl_rate, co.cgl_rate),
    num(b.sales_tax_rate, co.sales_tax_rate),
    b.tax_mode != null ? String(b.tax_mode) : co.tax_mode,
    id
  );

  res.json(hydrate(db.prepare('SELECT * FROM change_orders WHERE id = ?').get(id)));
});

// ---- REPLACE LINES ----
// Whole-array replace, mirroring the SOV endpoint, because the frontend debounces
// onto it. Idempotent: saving the same array twice leaves the same rows.
router.put('/:id/lines', (req, res) => {
  const id = Number(req.params.id);
  const co = db.prepare('SELECT * FROM change_orders WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!co) return res.status(404).json({ error: 'not found' });
  const est = loadParent(co.estimate_id);
  if (!canReach(req.user, est)) return res.status(403).json({ error: 'Access denied.' });

  const rows = Array.isArray(req.body) ? req.body : [];
  const del = db.prepare('DELETE FROM change_order_lines WHERE change_order_id = ?');
  const ins = db.prepare(
    'INSERT INTO change_order_lines (change_order_id, description, qty, unit, unit_cost, position) VALUES (?,?,?,?,?,?)'
  );
  const tx = db.transaction(arr => {
    del.run(id);
    // A credit is simply a negative qty, as in the approved mockup.
    arr.forEach((l, i) => ins.run(
      id,
      String(l.description || ''),
      +l.qty || 0,
      String(l.unit || 'ea'),
      +l.unit_cost || 0,
      i
    ));
    db.prepare("UPDATE change_orders SET updated_at = datetime('now') WHERE id = ?").run(id);
  });
  tx(rows);

  res.json(hydrate(db.prepare('SELECT * FROM change_orders WHERE id = ?').get(id)));
});

// ---- SOFT DELETE ----
router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  const co = db.prepare('SELECT * FROM change_orders WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!co) return res.status(404).json({ error: 'not found' });
  const est = loadParent(co.estimate_id);
  if (!canReach(req.user, est)) return res.status(403).json({ error: 'Access denied.' });

  db.prepare("UPDATE change_orders SET deleted_at = datetime('now') WHERE id = ?").run(id);
  res.json({ ok: true, id });
});

module.exports = router;
