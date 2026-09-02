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

// Used when a change order is written with no bid attached, so there is no
// parent estimate to copy rates from. Same numbers as the column defaults in
// migration 051.
const DEFAULT_RATES = {
  oh_rate: 0.05,
  contingency_rate: 0,
  profit_rate: 0.10,
  cgl_rate: 0,
  sales_tax_rate: 0.06,
  tax_mode: 'full'
};

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

// A change order MAY hang off an estimates row, but does not have to. With no
// parent it is 'standalone' and carries its own project_name / client_gc.
// With a parent, parent_type is 'job' when that estimate is Won and carries a
// job number, otherwise 'bid'. Because it is the same row either way, a CO
// written against an open bid picks up the job number automatically once the
// bid is marked Won.
function parentTypeFor(est) {
  if (!est) return 'standalone';
  const hasJob = est.status === 'Won' && est.job_number != null && String(est.job_number).trim() !== '';
  return hasJob ? 'job' : 'bid';
}

function loadParent(estimateId) {
  if (estimateId == null || estimateId === '') return null;
  return db.prepare(
    // job_type is here so a change order against a process-only job opens the
    // process-only estimator rather than the full structural one. The po_* rates
    // come with it, because the process cascade reads those and none of the
    // oh/contingency/profit/cgl ones.
    `SELECT id, project_name, job_number, bid_number, client_gc, status, created_by,
            job_type,
            oh_rate, contingency_rate, profit_rate, cgl_rate, sales_tax_rate, tax_mode,
            po_labor_rate, po_cost_rate, po_op_pct, po_tax_pct, po_galv_rate,
            po_plate_rate, po_process_rate, po_process_rate_beam,
            po_process_rate_channel, po_process_rate_angle, po_beam_fab_rate,
            po_pf_rate_beam, po_pf_rate_channel, po_pf_rate_angle,
            po_consumables_rate, po_trucking_rate
       FROM estimates
      WHERE id = ? AND deleted_at IS NULL`
  ).get(Number(estimateId)) || null;
}

// Standalone change orders run on their own sequence, kept apart from the
// per-bid sequences so CO-004 with no bid never collides with "Bid 1234 CO-004".
function nextSeq(estimateId) {
  const row = estimateId == null
    ? db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM change_orders WHERE estimate_id IS NULL').get()
    : db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM change_orders WHERE estimate_id = ?').get(estimateId);
  return row.m + 1;
}

// Estimators may only see change orders hanging off estimates assigned to them.
// An estimate with no owner is admin-only, same rule as the bids list itself.
// A standalone change order has no estimate to inherit ownership from, so it
// belongs to whoever created it. Admins and superadmins see everything.
function canReach(user, est, co) {
  if (!user) return false;
  if (isAdminish(user.role)) return true;
  if (est) return est.created_by === user.userId;
  if (co) return co.created_by === user.userId;
  return false;   // a parent was expected and could not be loaded
}

function linesFor(coId) {
  return db.prepare(
    'SELECT * FROM change_order_lines WHERE change_order_id = ? ORDER BY position, id'
  ).all(coId);
}

// ---- FULL-ESTIMATOR CHANGE ORDERS ----
// A change order priced with the full estimator is backed by its own row in
// `estimates`, so the existing estimate editor, its cost inputs and its client
// proposal all work on it untouched. That row is not a bid: it carries
// change_order_id, and every query that lists or counts bids filters on
// change_order_id IS NULL.
function backingEstimate(coId) {
  return db.prepare(
    'SELECT * FROM estimates WHERE change_order_id = ? AND deleted_at IS NULL'
  ).get(coId) || null;
}

// Created the first time a change order is set to estimator pricing. Rates and
// job type come from the job the CO hangs off, so the change order is priced the
// way the job was, which is the same rule the quick path already follows.
function createBackingEstimate(co, parentEst, userId) {
  // Deliberately looks past deleted_at. A backing estimate that was soft-deleted
  // still holds real priced work, so it is revived rather than left orphaned
  // behind a second, empty one that no screen could ever reach.
  const existing = db.prepare(
    'SELECT * FROM estimates WHERE change_order_id = ? ORDER BY id LIMIT 1'
  ).get(co.id);
  if (existing) {
    if (existing.deleted_at != null) {
      db.prepare('UPDATE estimates SET deleted_at = NULL WHERE id = ?').run(existing.id);
      return db.prepare('SELECT * FROM estimates WHERE id = ?').get(existing.id);
    }
    return existing;
  }

  const isProcess = !!(parentEst && parentEst.job_type === 'process_only');
  const info = db.prepare(
    // bid_type is set to 'change_order' rather than left at its 'real' default.
    // Every query that counts bids already filters on change_order_id IS NULL,
    // but the counting queries ALSO filter on (bid_type = 'real' OR bid_type IS
    // NULL), so this row now fails both tests independently. If a guard is ever
    // missed on a new query, this still keeps it out of the numbers.
    `INSERT INTO estimates
       (project_name, client_gc, scope, status, job_type, confirmed, is_alternate,
        bid_type, change_order_id, oh_rate, contingency_rate, profit_rate, cgl_rate,
        sales_tax_rate, tax_mode, created_by)
     VALUES (?,?,?,?,?,1,0,'change_order',?,?,?,?,?,?,?,?)`
  ).run(
    // Named for the CO, not the job, so it is obvious what it is if it is ever
    // seen directly.
    (parentEst ? (parentEst.project_name || '') : (co.project_name || '')) + ' — ' + co.title,
    parentEst ? (parentEst.client_gc || '') : (co.client_gc || ''),
    co.scope || '',
    'Draft',
    (parentEst && parentEst.job_type) || 'full',
    co.id,
    +co.oh_rate || 0,
    +co.contingency_rate || 0,
    +co.profit_rate || 0,
    +co.cgl_rate || 0,
    +co.sales_tax_rate || 0,
    co.tax_mode || 'full',
    // Owned by whoever owns the JOB, not by whoever happened to write the change
    // order. Access to a change order is granted through its parent estimate
    // (see canReach), so an owner mismatch here would let someone open a CO and
    // then be refused by the estimate editor behind it.
    (parentEst && parentEst.created_by) || userId
  );
  const backingId = info.lastInsertRowid;

  if (isProcess) {
    // The process cascade reads none of the rates copied above; these are the
    // ones it actually uses, so without them the change order would be priced at
    // the shop defaults rather than the way the job was priced.
    const PO_RATES = [
      'po_labor_rate', 'po_cost_rate', 'po_op_pct', 'po_tax_pct', 'po_galv_rate',
      'po_plate_rate', 'po_process_rate', 'po_process_rate_beam',
      'po_process_rate_channel', 'po_process_rate_angle', 'po_beam_fab_rate',
      'po_pf_rate_beam', 'po_pf_rate_channel', 'po_pf_rate_angle',
      'po_consumables_rate', 'po_trucking_rate'
    ];
    const carry = PO_RATES.filter(f => parentEst[f] != null);
    if (carry.length) {
      db.prepare(
        'UPDATE estimates SET ' + carry.map(f => f + ' = ?').join(', ') + ' WHERE id = ?'
      ).run(...carry.map(f => parentEst[f]), backingId);
    }
    // Same starting lines a new process-only bid gets, otherwise the tab opens
    // empty with nothing to type into.
    try {
      const { seedProcessOnlyDefaults } = require('./estimates');
      if (typeof seedProcessOnlyDefaults === 'function') seedProcessOnlyDefaults(backingId);
    } catch (e) {
      console.error('[change orders] process-only seed failed:', e.message);
    }
  }

  return db.prepare('SELECT * FROM estimates WHERE id = ?').get(backingId);
}

// The estimator's cascade, restated in the shape the change-order screen and the
// list expect. Required lazily: routes/estimates.js is a heavier module and this
// is the only thing needed from it. Read-only, so nothing about estimates moves.
function computedFromBacking(estimateId) {
  let bundle = null;
  try {
    const { loadFullEstimate } = require('./estimates');
    bundle = loadFullEstimate(estimateId);
  } catch (e) {
    return null;
  }
  if (!bundle || !bundle.estimate) return null;

  // Price to win, when the estimator has set one, IS the sell price — it is what
  // the client proposal quotes. Every other consumer in the app honours it
  // (the bids list, reports, the tracker push, the SOV), so a change order that
  // ignored it would show the office a different number from the one the
  // customer was sent. sellPretax is that shared rule.
  let sell;
  try {
    const { sellPretax } = require('./estimates');
    sell = typeof sellPretax === 'function' ? +sellPretax(bundle) || 0 : null;
  } catch (e) {
    sell = null;
  }

  // A process-only change order is priced by the process-only cascade, exactly
  // as a process-only bid is. Reading bundle.computed for one of those would
  // report the structural numbers, which for a process job are all zero.
  if (bundle.estimate.job_type === 'process_only') {
    const p = bundle.processComputed;
    if (!p) return null;
    const cost = +p.yourCost || 0;
    if (sell == null) sell = (+p.subTotal || 0) + (+p.opAmt || 0);
    const tax = +p.taxAmt || 0;
    const op = +p.opAmt || 0;
    const gp = sell - cost;
    return {
      cost,
      // The process cascade rolls overhead, contingency, profit and CGL into a
      // single O&P figure, so there is nothing honest to split it into. It is
      // reported under profit and the other three read zero.
      oh: 0, cont: 0, prof: op, cgl: 0,
      // What is left between cost + O&P and the sell price: the labor markup the
      // process cascade carries, plus any price-to-win difference. Shown so the
      // column on screen actually adds up.
      roundingAdj: sell - (cost + op),
      sell, tax,
      total: sell + tax,
      gp,
      margin: sell ? gp / sell : 0,
      markupPct: cost ? gp / cost : 0
    };
  }

  if (!bundle.computed) return null;
  const c = bundle.computed;
  const cost = +c.directCost || 0;
  if (sell == null) sell = +c.totalBid || 0;
  const tax = (c.tax && +c.tax.amount) || 0;
  const gp = sell - cost;
  const oh = (c.markup && +c.markup.oh) || 0;
  const cont = (c.markup && +c.markup.cont) || 0;
  const prof = (c.markup && +c.markup.profit) || 0;
  const cgl = (c.markup && +c.markup.cgl) || 0;
  return {
    cost, oh, cont, prof, cgl,
    sell,
    // totalBid is rounded up to the whole dollar while its parts are not, and a
    // price to win moves the sell price outright, so the column would not add
    // up. The difference is shown rather than hidden.
    roundingAdj: sell - (cost + oh + cont + prof + cgl),
    tax,
    total: sell + tax,
    gp,
    margin: sell ? gp / sell : 0,
    markupPct: cost ? gp / cost : 0
  };
}

function label(co, est) {
  const n = 'CO-' + String(co.seq).padStart(3, '0');
  if (!est) return n;                                  // standalone
  if (co.parent_type === 'job') return ((est && est.job_number) || '') + ' ' + n;
  return 'Bid ' + ((est && est.bid_number) || '') + ' ' + n;
}

function hydrate(co) {
  const est = loadParent(co.estimate_id);
  const lines = linesFor(co.id);

  // An estimator change order takes its money from its backing estimate; the
  // quick path adds up its own line items. If a CO is set to estimator but its
  // backing estimate has gone missing, the quick cascade is used rather than
  // showing nothing.
  const backing = co.pricing_mode === 'estimator' ? backingEstimate(co.id) : null;
  const fromBacking = backing ? computedFromBacking(backing.id) : null;

  return {
    ...co,
    label: label(co, est),
    estimator_estimate_id: backing ? backing.id : null,
    // project_name / client_gc on the row are kept in sync with the parent on
    // every write, so these two fields are always safe to print, linked or not.
    project_name: est ? (est.project_name || '') : (co.project_name || ''),
    client_gc: est ? (est.client_gc || '') : (co.client_gc || ''),
    parent: est ? {
      id: est.id,
      project_name: est.project_name,
      job_number: est.job_number,
      bid_number: est.bid_number,
      client_gc: est.client_gc,
      status: est.status
    } : null,
    lines,
    computed: fromBacking || calc(co, lines)
  };
}

// Enforced on create and on update. Deliberately thin: a change order gets
// written in the field, often on a phone, and the point of starting one is to
// capture the change before it is forgotten. Reason, requested-by and scope all
// used to be mandatory up front, which meant a CO could not be opened at all
// until every box was filled. They are now filled in on the detail screen at
// whatever pace suits. A title is the one thing needed to tell one CO from
// another in the list, so it is all that is enforced here.
//
// The job is required by the NEW-change-order screen rather than by this
// function, because change orders created before that rule stand on their own
// and still have to save.
function missingRequired(body) {
  const missing = [];
  if (!String(body.title || '').trim()) missing.push('title');
  return missing;
}

// ---- TARGETS ----
// Everything a change order can be attached to: Won jobs first, then open bids.
router.get('/targets', (req, res) => {
  let rows = db.prepare(
    `SELECT id, project_name, job_number, bid_number, client_gc, status, created_by,
            oh_rate, contingency_rate, profit_rate, cgl_rate, sales_tax_rate, tax_mode
       FROM estimates
      WHERE deleted_at IS NULL AND is_alternate = 0 AND change_order_id IS NULL
      ORDER BY COALESCE(job_number, bid_number)`
  ).all();

  if (!isAdminish(req.user.role)) {
    rows = rows.filter(r => r.created_by === req.user.userId);
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
  // Standalone change orders sort first, then everything grouped by its bid.
  const all = db.prepare(
    `SELECT * FROM change_orders
      WHERE deleted_at IS NULL
      ORDER BY (estimate_id IS NOT NULL), estimate_id, seq`
  ).all();

  const out = [];
  for (const co of all) {
    const est = loadParent(co.estimate_id);
    if (co.estimate_id != null && !est) continue;   // parent deleted out from under it
    if (!canReach(req.user, est, co)) continue;
    if (req.query.status && co.status !== req.query.status) continue;
    // ?estimate_id=none returns only the unattached ones.
    if (req.query.estimate_id === 'none') {
      if (co.estimate_id != null) continue;
    } else if (req.query.estimate_id && co.estimate_id !== Number(req.query.estimate_id)) {
      continue;
    }
    out.push(hydrate(co));
  }
  res.json(out);
});

// ---- READ ONE ----
router.get('/:id', (req, res) => {
  const co = db.prepare('SELECT * FROM change_orders WHERE id = ? AND deleted_at IS NULL').get(Number(req.params.id));
  if (!co) return res.status(404).json({ error: 'not found' });
  const est = loadParent(co.estimate_id);
  if (!canReach(req.user, est, co)) return res.status(403).json({ error: 'Access denied.' });
  res.json(hydrate(co));
});

// ---- CREATE ----
router.post('/', (req, res) => {
  const b = req.body || {};
  const missing = missingRequired(b);
  if (missing.length) return res.status(400).json({ error: 'missing required fields', fields: missing });

  // A bid is optional. If one is named it must exist and be reachable; if none
  // is named the change order simply stands on its own.
  const est = b.estimate_id ? loadParent(b.estimate_id) : null;
  if (b.estimate_id && !est) return res.status(404).json({ error: 'parent estimate not found' });
  if (!canReach(req.user, est, { created_by: req.user.userId })) {
    return res.status(403).json({ error: 'Access denied.' });
  }

  const pricing = b.pricing_mode === 'estimator' ? 'estimator' : 'quick';

  // Rates are snapshotted from the parent at create time so a change order keeps
  // the pricing it was written under if the parent estimate is later re-rated.
  // With no parent there is nothing to copy, so the shop defaults apply.
  const src = est || DEFAULT_RATES;

  const info = db.prepare(
    `INSERT INTO change_orders
       (estimate_id, parent_type, project_name, client_gc, seq, title, reason,
        requested_by, scope, pricing_mode, status, oh_rate, contingency_rate,
        profit_rate, cgl_rate, sales_tax_rate, tax_mode, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    est ? est.id : null,
    parentTypeFor(est),
    est ? (est.project_name || '') : String(b.project_name || '').trim(),
    est ? (est.client_gc || '') : String(b.client_gc || '').trim(),
    nextSeq(est ? est.id : null),
    String(b.title || '').trim(),
    // Blank rather than the string "undefined" when the field was never sent.
    String(b.reason || '').trim(),
    String(b.requested_by || '').trim(),
    String(b.scope || '').trim(),
    pricing,
    'Draft',
    b.oh_rate != null ? +b.oh_rate : (+src.oh_rate || 0),
    b.contingency_rate != null ? +b.contingency_rate : (+src.contingency_rate || 0),
    b.profit_rate != null ? +b.profit_rate : (+src.profit_rate || 0),
    b.cgl_rate != null ? +b.cgl_rate : (+src.cgl_rate || 0),
    b.sales_tax_rate != null ? +b.sales_tax_rate : (+src.sales_tax_rate || 0),
    b.tax_mode || src.tax_mode || 'full',
    req.user.userId
  );

  const co = db.prepare('SELECT * FROM change_orders WHERE id = ?').get(info.lastInsertRowid);

  // Estimator pricing needs its backing estimate to exist before the editor can
  // be opened on it.
  // A change order marked estimator with no pricing behind it is a broken
  // record, so this failing takes the whole create with it rather than handing
  // back a 201 for something half-made.
  if (pricing === 'estimator') {
    try {
      createBackingEstimate(co, est, req.user.userId);
    } catch (e) {
      console.error('[change orders] backing estimate failed:', e.message);
      // Undo the change order too, rather than leaving one that claims an
      // estimator it does not have. Any estimate row that did get inserted is
      // detached first: foreign keys are on, so deleting the change order out
      // from under it would throw and the rollback itself would fail.
      try {
        db.prepare('UPDATE estimates SET change_order_id = NULL, deleted_at = COALESCE(deleted_at, datetime(\'now\')) WHERE change_order_id = ?').run(co.id);
        db.prepare('DELETE FROM change_orders WHERE id = ?').run(co.id);
      } catch (e2) {
        console.error('[change orders] rollback failed:', e2.message);
      }
      return res.status(500).json({ error: 'Could not set up the estimator for this change order. Nothing was saved.' });
    }
  }

  res.status(201).json(hydrate(co));
});

// ---- UPDATE ----
router.put('/:id', (req, res) => {
  const id = Number(req.params.id);
  const co = db.prepare('SELECT * FROM change_orders WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!co) return res.status(404).json({ error: 'not found' });
  const est = loadParent(co.estimate_id);
  if (!canReach(req.user, est, co)) return res.status(403).json({ error: 'Access denied.' });

  const b = req.body || {};

  // The attached bid can be changed at any time: added to a standalone CO,
  // swapped, or cleared back to standalone. Send estimate_id: null to detach.
  // Leave the key out of the body entirely to keep whatever is already there.
  const reparenting = Object.prototype.hasOwnProperty.call(b, 'estimate_id');
  const newParentId = reparenting
    ? (b.estimate_id === '' || b.estimate_id == null ? null : Number(b.estimate_id))
    : co.estimate_id;

  let newEst = est;
  if (reparenting && newParentId !== co.estimate_id) {
    newEst = loadParent(newParentId);
    if (newParentId != null && !newEst) {
      return res.status(404).json({ error: 'parent estimate not found' });
    }
    // You cannot park a change order on someone else's bid.
    if (!canReach(req.user, newEst, co)) return res.status(403).json({ error: 'Access denied.' });
  }

  const merged = {
    estimate_id: newParentId,
    title: b.title != null ? b.title : co.title,
    reason: b.reason != null ? b.reason : co.reason,
    requested_by: b.requested_by != null ? b.requested_by : co.requested_by,
    scope: b.scope != null ? b.scope : co.scope,
    project_name: b.project_name != null ? b.project_name : co.project_name
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

  // Moving between a bid and standalone moves the CO onto the other numbering
  // series, but only while it is still a Draft. Once it has been sent out the
  // number it was sent under is the number it keeps, whatever it gets attached
  // to afterwards.
  const parentChanged = newParentId !== co.estimate_id;
  const seq = (parentChanged && co.status === 'Draft') ? nextSeq(newParentId) : co.seq;

  // Project and customer track the attached bid. Detached, they are yours to type.
  const projectName = newEst ? (newEst.project_name || '')
                             : String(merged.project_name || '').trim();
  const clientGc = newEst ? (newEst.client_gc || '')
                          : (b.client_gc != null ? String(b.client_gc).trim() : (co.client_gc || ''));

  // Rates are NOT re-copied on re-parent. A change order keeps the pricing it
  // was written under; change the rates by hand if that is what you want.
  db.prepare(
    `UPDATE change_orders
        SET estimate_id = ?, parent_type = ?, project_name = ?, client_gc = ?, seq = ?,
            title = ?, reason = ?, requested_by = ?, scope = ?,
            pricing_mode = ?, status = ?,
            oh_rate = ?, contingency_rate = ?, profit_rate = ?, cgl_rate = ?,
            sales_tax_rate = ?, tax_mode = ?,
            updated_at = datetime('now')
      WHERE id = ?`
  ).run(
    newParentId,
    parentTypeFor(newEst),
    projectName,
    clientGc,
    seq,
    String(merged.title || '').trim(),
    String(merged.reason || '').trim(),
    String(merged.requested_by || '').trim(),
    String(merged.scope || '').trim(),
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

  const after = db.prepare('SELECT * FROM change_orders WHERE id = ?').get(id);

  // Switching a change order onto estimator pricing gives it its backing
  // estimate. Switching back the other way deliberately leaves that estimate
  // alone: the quick line items and the estimator each keep their own work, so
  // flipping the mode to look at the other one never destroys anything.
  if (pricing === 'estimator') {
    try {
      createBackingEstimate(after, newEst, req.user.userId);
    } catch (e) {
      console.error('[change orders] backing estimate failed:', e.message);
      // The rest of the update stands; only the switch to estimator did not, so
      // the mode is put back rather than leaving it claiming an estimator that
      // is not there.
      db.prepare("UPDATE change_orders SET pricing_mode = ? WHERE id = ?").run(co.pricing_mode, id);
      return res.status(500).json({ error: 'Could not set up the estimator for this change order.' });
    }
  }

  res.json(hydrate(after));
});

// ---- REPLACE LINES ----
// Whole-array replace, mirroring the SOV endpoint, because the frontend debounces
// onto it. Idempotent: saving the same array twice leaves the same rows.
router.put('/:id/lines', (req, res) => {
  const id = Number(req.params.id);
  const co = db.prepare('SELECT * FROM change_orders WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!co) return res.status(404).json({ error: 'not found' });
  const est = loadParent(co.estimate_id);
  if (!canReach(req.user, est, co)) return res.status(403).json({ error: 'Access denied.' });

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
  if (!canReach(req.user, est, co)) return res.status(403).json({ error: 'Access denied.' });

  db.prepare("UPDATE change_orders SET deleted_at = datetime('now') WHERE id = ?").run(id);

  // The backing estimate of an estimator CO goes with it, otherwise it is left
  // orphaned and invisible with no way to reach it. Soft delete, same as the CO,
  // so nothing is actually destroyed. It stays out of the trash list because
  // that list filters on change_order_id IS NULL.
  db.prepare(
    "UPDATE estimates SET deleted_at = datetime('now') WHERE change_order_id = ? AND deleted_at IS NULL"
  ).run(id);

  res.json({ ok: true, id });
});

module.exports = router;
