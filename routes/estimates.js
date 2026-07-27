'use strict';
const express = require('express');
const multer = require('multer');
const db = require('../db');
const calc = require('../lib/calc');
const { computeProcess } = require('../lib/calc_process');
const { parseKiss, parseKissToTakeoff } = require('../lib/kiss');
const { parseTemplate } = require('../lib/parser');
const { buildProposalView } = require('../lib/proposal_lines');
const { footSovItems } = require('../lib/round');
const { generateProposalBuffer } = require('../lib/pdf');
const { sendReadyToSubmit, sendResubmitNotification, sendWonNotification } = require('../lib/email');
const { buildWonJobPayload, pushWonJobToTracker } = require('../lib/tracker_push');
const { buildSnapshot, diffSnapshots } = require('../lib/resubmit_diff');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

const { normalizeLabel } = require('../lib/sections');
const aiscStmt = db.prepare('SELECT weight_per_ft FROM aisc_sections WHERE label_norm = ?');
function aiscLookup(label) {
  if (!label) return 0;
  const row = aiscStmt.get(normalizeLabel(label));
  return row ? row.weight_per_ft : 0;
}

// ---- Bid number sequence ----
// Shared series for all job types. Next base = highest base number used + 1,
// floored at 2000. Revisions of a bid get a .N suffix (2000.1, 2000.2, ...).
function nextBidNumber() {
  const rows = db.prepare("SELECT bid_number FROM estimates WHERE bid_number IS NOT NULL AND bid_number != ''").all();
  let maxBase = 1999;
  for (const r of rows) {
    const base = parseInt(String(r.bid_number).split('.')[0], 10);
    if (Number.isFinite(base) && base > maxBase) maxBase = base;
  }
  return String(maxBase + 1);
}
function nextRevision(base) {
  const rows = db.prepare("SELECT bid_number FROM estimates WHERE bid_number LIKE ?").all(base + '.%');
  let maxRev = 0;
  for (const r of rows) {
    const rev = parseInt(String(r.bid_number).split('.')[1], 10);
    if (Number.isFinite(rev) && rev > maxRev) maxRev = rev;
  }
  return base + '.' + (maxRev + 1);
}

function buildSovItems(bundle) {
  const e = bundle.estimate;
  const c = bundle.computed;
  const m = (1 + (+e.oh_rate || 0)) * (1 + (+e.contingency_rate || 0))
          * (1 + (+e.profit_rate || 0)) * (1 + (+e.cgl_rate || 0));
  const items = [];

  // Add scope as item 0 if present
  if (e.scope && e.scope.trim()) {
    items.push({ item_no: '0', description: 'Scope of Work: ' + e.scope, scheduled_value: 0 });
  }

  const exTot = (sec) => (bundle.extras || []).filter(x => (+x.section) === sec)
    .reduce((acc, x) => acc + (+x.qty || 0) * (+x.rate || 0), 0);
  const exFab = exTot(2) + exTot(3);
  const exErect = exTot(4);

  // Material and finishes
  items.push(
    { item_no: '1', description: 'Structural Steel Material — Furnished', scheduled_value: c.materialPrice * m },
    { item_no: '2', description: 'Shop Fabrication and Finishes',         scheduled_value: (c.fabHours + c.paint + c.consumables + c.handling + c.processingLabor + exFab) * m },
    { item_no: '3', description: 'Detailing and PE-Stamped Shop Drawings', scheduled_value: (((+e.struct_detailing||0)*(+e.struct_detailing_qty||1)) + ((+e.misc_detailing||0)*(+e.misc_detailing_qty||1)) + ((+e.pe_stamp||0)*(+e.pe_stamp_qty||1))) * m },
    { item_no: '4', description: 'Freight to Jobsite',                    scheduled_value: (+e.freight || 0) * (+e.freight_qty || 1) * m },
    { item_no: '5', description: 'Field Erection, Equipment, and Rigging', scheduled_value: (c.erectionLabor + (+e.erection_equip || 0) * (+e.erection_equip_qty || 1) + exErect) * m },
    { item_no: '6', description: 'Galvanizing',                           scheduled_value: c.galv * m }
    // Processing Labor (was item 7) is bundled into item 2 above.
  );

  let next = 7;
  if ((+e.sub_joist_deck || 0) > 0)
    items.push({ item_no: String(next++), description: 'Joist and Deck — by Subcontractor', scheduled_value: (+e.sub_joist_deck || 0) * (+e.sub_joist_deck_qty || 1) * m });
  if ((+e.sub_erection || 0) > 0)
    items.push({ item_no: String(next++), description: 'Erection — by Subcontractor', scheduled_value: (+e.sub_erection || 0) * (+e.sub_erection_qty || 1) * m });
  // Cost-Inputs extra rows are folded into items 1/2/5 above, never their own line.
  const out = items.filter((it, i) => i === 0 || it.scheduled_value > 0).map((it, i) => ({ ...it, position: i }));
  return footSovItems(out);
}

const EST_COLS = [
  'project_name', 'job_number', 'client_gc', 'bid_date', 'proposal_date', 'drawing_numbers',
  'prepared_by', 'scope', 'status',
  'fab_mh', 'fab_rate', 'processing_rate',
  'paint_weight', 'paint_rate', 'consumables_weight', 'consumables_rate',
  'handling_weight', 'handling_rate', 'galv_weight', 'galv_rate',
  'struct_detailing', 'misc_detailing', 'pe_stamp', 'freight',
  'erection_mh', 'erection_rate', 'erection_equip',
  'oh_rate', 'contingency_rate', 'profit_rate', 'cgl_rate',
  'sales_tax_rate', 'tax_mode',
  'proposal_to', 'proposal_scope', 'proposal_exclusions', 'proposal_terms', 'proposal_submitted_by', 'proposal_notes',
  'proposal_line_1_desc', 'proposal_line_2_desc', 'proposal_line_3_desc',
  'proposal_line_4_desc', 'proposal_line_5_desc', 'proposal_line_6_desc', 'proposal_line_7_desc',
  'ljb_tons', 'ljb_distance_miles', 'ljb_galv_lbs', 'ljb_aess_lbs',
  'ljb_aess_rate', 'ljb_galv_rate', 'ljb_joist_sub1', 'ljb_joist_sub2',
  'ljb_erect_sub1', 'ljb_erect_sub2', 'ljb_op_rate', 'ljb_shop_dwg_pages',
  'submitted_at',
  'notes',
  'sub_joist_deck', 'sub_erection',
  'struct_detailing_qty', 'misc_detailing_qty', 'pe_stamp_qty',
  'freight_qty', 'erection_equip_qty', 'sub_joist_deck_qty', 'sub_erection_qty',
  // Process-only mode
  'job_type',
  'po_labor_rate', 'po_cost_rate', 'po_beam_fab_rate', 'po_process_rate',
  'po_process_rate_beam', 'po_process_rate_channel', 'po_process_rate_angle',
  'po_pf_rate_beam', 'po_pf_rate_channel', 'po_pf_rate_angle',
  'po_galv_rate', 'po_trucking_rate', 'po_plate_rate', 'po_consumables_rate',
  'po_op_pct', 'po_tax_pct',
  // Hide-until-saved
  'confirmed',
  // Alternates (user-editable fields; is_alternate/parent_estimate_id are set
  // only by the dedicated alternate endpoints, never via a generic update)
  'alt_label', 'alt_position',
  // Price to win: the final price you quote (NULL = use computed cost-plus).
  // client_quote_amount snapshots the "set as client quote" price.
  'price_to_win', 'client_quote_amount',
  // Bid type: 'real' (counts in dashboard totals) | 'test' | 'demo' | 'superseded'.
  // Only 'real' is summed on the dashboard.
  'bid_type'
];

// Rate and markup fields an alternate inherits from its base bid. An alternate
// shares the bid's pricing assumptions; only its takeoff and finishes weights
// are its own. Covers both full-job and process-only rate fields.
const INHERITED_RATE_FIELDS = [
  'fab_rate', 'processing_rate',
  'paint_rate', 'consumables_rate', 'handling_rate', 'galv_rate',
  'erection_rate',
  'oh_rate', 'contingency_rate', 'profit_rate', 'cgl_rate',
  'sales_tax_rate', 'tax_mode',
  'po_labor_rate', 'po_cost_rate', 'po_beam_fab_rate', 'po_process_rate',
  'po_process_rate_beam', 'po_process_rate_channel', 'po_process_rate_angle',
  'po_pf_rate_beam', 'po_pf_rate_channel', 'po_pf_rate_angle',
  'po_galv_rate', 'po_trucking_rate', 'po_plate_rate', 'po_consumables_rate',
  'po_op_pct', 'po_tax_pct'
];

function loadFullEstimate(id, opts = {}) {
  // includeDeleted lets the read-only "view a deleted bid" path load a
  // soft-deleted estimate. Every other caller omits it, so behavior is
  // unchanged (deleted bids stay invisible) for the dashboard, feed, etc.
  const est = opts.includeDeleted
    ? db.prepare('SELECT * FROM estimates WHERE id = ?').get(id)
    : db.prepare('SELECT * FROM estimates WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!est) return null;
  // Alternates inherit the base bid's rates and markup, in memory only (never
  // persisted). Base bids are never touched here, so their pricing is identical
  // to before this feature existed.
  if (est.is_alternate && est.parent_estimate_id) {
    const parent = db.prepare('SELECT * FROM estimates WHERE id = ?').get(est.parent_estimate_id);
    if (parent) for (const f of INHERITED_RATE_FIELDS) est[f] = parent[f];
  }
  const overrides = db.prepare('SELECT section, weight_lb, cost_per_cwt, source FROM material_overrides WHERE estimate_id = ?').all(id);
  const shapes = db.prepare('SELECT * FROM takeoff_shapes WHERE estimate_id = ? ORDER BY section_type, position').all(id);
  const plates = db.prepare('SELECT * FROM takeoff_plates WHERE estimate_id = ? ORDER BY position').all(id);
  const misc = db.prepare('SELECT * FROM takeoff_misc WHERE estimate_id = ? ORDER BY position').all(id);
  const wages = db.prepare('SELECT * FROM wage_rates WHERE estimate_id = ?').all(id);
  const extras = db.prepare('SELECT * FROM estimate_extras WHERE estimate_id = ? ORDER BY section, position').all(id);
  // Client-proposal line edits: manually added lines and per-line hide state.
  // Empty for estimates that have never used the feature, so the proposal/SOV
  // and totals are unchanged from before.
  const manualLines = db.prepare('SELECT * FROM proposal_manual_lines WHERE estimate_id = ? ORDER BY position, id').all(id);
  const lineVisibility = db.prepare('SELECT * FROM proposal_line_visibility WHERE estimate_id = ?').all(id);
  // Editable client-facing breakdown overrides (where the price-to-win discount
  // lands, per line). Empty = scaled default.
  const clientLines = db.prepare('SELECT * FROM proposal_client_lines WHERE estimate_id = ?').all(id);
  const computed = calc.compute(est, overrides, shapes, plates, misc, aiscLookup, extras);
  const standardExclusions = db.prepare('SELECT * FROM standard_exclusions ORDER BY position, id').all();
  const siteExclusions = db.prepare('SELECT * FROM estimate_site_exclusions WHERE estimate_id = ? ORDER BY position, id').all(id);
  // Process-only data (empty for full jobs)
  const processLines = db.prepare('SELECT * FROM process_only_lines WHERE estimate_id = ? ORDER BY position, id').all(id);
  const processAddcosts = db.prepare('SELECT * FROM process_only_addcosts WHERE estimate_id = ? ORDER BY position, id').all(id);
  const processComputed = computeProcess(est, processLines, processAddcosts);
  // Resubmit history: who/when/why (+ auto-detected changes) for each in-place
  // resubmit of this bid. Newest first. Empty for bids never resubmitted.
  const resubmits = db.prepare('SELECT id, note, user_id, user_name, created_at, changes FROM estimate_resubmits WHERE estimate_id = ? ORDER BY created_at DESC, id DESC').all(id);
  for (const r of resubmits) {
    try { r.changes = r.changes ? JSON.parse(r.changes) : []; }
    catch (e) { r.changes = []; }
  }
  return { estimate: est, overrides, shapes, plates, misc, wages, extras, computed, standardExclusions, siteExclusions, processLines, processAddcosts, processComputed, manualLines, lineVisibility, clientLines, resubmits };
}

// ---- OWNERSHIP CHECK ----
// For estimators: only allow access to their own estimates (or legacy estimates with no owner).
// Admins and superadmins bypass this check entirely.
function isAdminish(role) {
  return role === 'admin' || role === 'superadmin';
}

function estimateOwnershipCheck(req, res, next) {
  if (!req.user || isAdminish(req.user.role)) return next();
  const id = Number(req.params.id);
  if (!id) return next();
  // No deleted_at filter here: ownership must still apply to soft-deleted bids
  // so an estimator can only view their own deleted bids, not everyone's.
  const est = db.prepare('SELECT created_by FROM estimates WHERE id = ?').get(id);
  if (!est) return next(); // let the route return 404
  if (est.created_by !== null && est.created_by !== req.user.userId) {
    return res.status(403).json({ error: 'Access denied.' });
  }
  next();
}

router.param('id', (req, res, next, id) => {
  estimateOwnershipCheck(req, res, next);
});

// Pre-tax sell price for a loaded estimate bundle. Mirrors the /summary revenue
// rule and the won-jobs feed: price_to_win when set, otherwise the computed
// total (process-only uses subtotal + O&P, before sales tax).
function sellPretax(bundle) {
  const e = bundle.estimate;
  const c = bundle.computed || {};
  const pc = bundle.processComputed || {};
  const ptw = (e.price_to_win != null && e.price_to_win !== '') ? (+e.price_to_win || 0) : null;
  if (e.job_type === 'process_only') {
    const poPreTax = (+pc.subTotal || 0) + (+pc.opAmt || 0);
    return ptw != null ? ptw : poPreTax;
  }
  return ptw != null ? ptw : (+c.totalBid || 0);
}

// Attach contract_amount (pre-tax sell) to each list row.
function attachAmounts(rows) {
  for (const row of rows) {
    try {
      const bundle = loadFullEstimate(row.id);
      row.contract_amount = bundle ? sellPretax(bundle) : 0;
    } catch {
      row.contract_amount = 0;
    }
  }
  return rows;
}

// ---- LIST ----
router.get('/', (req, res) => {
  if (isAdminish(req.user.role)) {
    const rows = db.prepare(`
      SELECT e.id, e.project_name, e.job_number, e.bid_number, e.client_gc, e.bid_date,
             e.status, e.job_type, e.bid_type, e.revised_from_id, e.updated_at, e.created_at, e.submitted_at, e.created_by, e.due_date,
             u.name as owner_name, u.email as owner_email
      FROM estimates e
      LEFT JOIN users u ON u.id = e.created_by
      WHERE e.deleted_at IS NULL AND e.confirmed = 1 AND e.is_alternate = 0
      ORDER BY e.updated_at DESC
    `).all();
    return res.json({ rows: attachAmounts(rows) });
  }
  // Estimators: only see their own + legacy estimates with no owner
  const rows = db.prepare(`
    SELECT e.id, e.project_name, e.job_number, e.bid_number, e.client_gc, e.bid_date,
           e.status, e.job_type, e.bid_type, e.revised_from_id, e.updated_at, e.created_at, e.submitted_at, e.created_by, e.due_date,
           u.name as owner_name, u.email as owner_email
    FROM estimates e
    LEFT JOIN users u ON u.id = e.created_by
    WHERE (e.created_by = ? OR e.created_by IS NULL) AND e.deleted_at IS NULL AND e.confirmed = 1 AND e.is_alternate = 0
    ORDER BY e.updated_at DESC
  `).all(req.user.userId);
  res.json({ rows: attachAmounts(rows) });
});

// ---- TRASH: list soft-deleted bids (restorable) ----
router.get('/deleted', (req, res) => {
  const base = `
    SELECT e.id, e.project_name, e.job_number, e.bid_number, e.client_gc,
           e.status, e.job_type, e.bid_type, e.deleted_at, e.updated_at, e.created_by,
           u.name as owner_name, u.email as owner_email
    FROM estimates e
    LEFT JOIN users u ON u.id = e.created_by
    WHERE e.deleted_at IS NOT NULL AND e.is_alternate = 0`;
  const rows = isAdminish(req.user.role)
    ? db.prepare(base + ' ORDER BY e.deleted_at DESC').all()
    : db.prepare(base + ' AND (e.created_by = ? OR e.created_by IS NULL) ORDER BY e.deleted_at DESC').all(req.user.userId);
  res.json({ rows });
});

// ---- DASHBOARD SUMMARY ----
// Per-estimate financials + key dates for the dashboard cards.
// revenue = total bid (sell price, before tax); profit = bid minus direct job cost.
// Respects the same role visibility as the list endpoint.
router.get('/summary', (req, res) => {
  // Only 'real' bids count toward dashboard totals. Test/Demo/Superseded bids
  // stay in the system (visible in the list) but are excluded here. NULL is
  // treated as 'real' so legacy rows keep counting.
  const idRows = isAdminish(req.user.role)
    ? db.prepare("SELECT id FROM estimates WHERE deleted_at IS NULL AND confirmed = 1 AND is_alternate = 0 AND (bid_type = 'real' OR bid_type IS NULL)").all()
    : db.prepare("SELECT id FROM estimates WHERE (created_by = ? OR created_by IS NULL) AND deleted_at IS NULL AND confirmed = 1 AND is_alternate = 0 AND (bid_type = 'real' OR bid_type IS NULL)").all(req.user.userId);

  const rows = [];
  for (const { id } of idRows) {
    const bundle = loadFullEstimate(id);
    if (!bundle) continue;
    const e = bundle.estimate;
    const c = bundle.computed || {};
    const isPO = e.job_type === 'process_only';
    const pc = bundle.processComputed || {};
    // Price to win is the ONLY thing that adjusts dashboard revenue/profit.
    // When it is blank, these are byte-for-byte the old cost-plus numbers, so
    // no existing bid moves (hide/exclude do not affect the dashboard).
    const ptw = (e.price_to_win != null && e.price_to_win !== '') ? (+e.price_to_win || 0) : null;
    let revenue, profit;
    if (isPO) {
      // Sell price BEFORE sales tax, matching how full-project bids are counted
      // (c.totalBid is pre-tax). Sales tax is a pass-through, so it must not
      // land in revenue or profit. price_to_win, when set, is the pre-tax sell.
      const poPreTax = (+pc.subTotal || 0) + (+pc.opAmt || 0);
      revenue = ptw != null ? ptw : poPreTax;
      profit  = revenue - (+pc.yourCost || 0);
    } else {
      // Profit uses REAL burdened cost (labor at loaded wage rates), matching the
      // proposal builder and the Margin Analysis / Client Proposal tabs, not the
      // old bid-rate estimate cost (c.directCost). Revenue behavior is unchanged
      // (price-to-win when set, else the computed bid; hide/exclude still ignored).
      const view = buildProposalView(bundle);
      revenue = ptw != null ? ptw : (+c.totalBid || 0);
      profit  = revenue - (+view.base.directCost || 0);
    }
    rows.push({
      id: e.id,
      project_name: e.project_name || '',
      bid_number: e.bid_number || '',
      job_type: e.job_type || 'full',
      status: e.status || 'Draft',
      created_at: e.created_at || null,
      submitted_at: e.submitted_at || null,
      won_at: e.won_at || null,
      proposal_date: e.proposal_date || null,
      bid_date: e.bid_date || null,
      revenue,
      profit
    });
  }
  res.json({ rows });
});

// ---- ACTIVITY FEED (read-only) ----
// Powers in-app desktop notifications: bids that were submitted or won since a
// given timestamp. The client polls this while the app is open and raises a
// browser notification for anything new. Writes nothing, and deliberately
// mirrors the email rules — Test/Demo bids and alternates never surface.
//
// `since` is an ISO timestamp; omit it to just get the server clock back so the
// client can establish a baseline without firing a burst of stale notifications.
//
// The two timestamp columns are written in DIFFERENT formats: submitted_at is a
// JS ISO string ("2026-07-27T15:10:19.042Z") while won_at comes from SQLite's
// datetime('now') ("2026-07-27 15:10:19"). A plain string compare puts every
// won_at BELOW any same-day ISO value (space sorts before 'T'), so Won events
// would never surface. Everything is normalised through datetime() on both
// sides instead. That costs sub-second precision, so the window is inclusive
// (>=) and each event carries a stable `key` for the client to dedupe on —
// an exclusive compare would silently drop an event landing in the same second
// as the previous poll's cutoff.
router.get('/activity', (req, res) => {
  const now = new Date().toISOString();
  const since = String(req.query.since || '').trim();
  if (!since) return res.json({ now, events: [] });
  if (isNaN(Date.parse(since))) return res.status(400).json({ error: 'since must be an ISO timestamp' });

  const rows = db.prepare(`
    SELECT id, bid_number, project_name, client_gc,
           CASE WHEN submitted_at IS NOT NULL AND datetime(submitted_at) >= datetime(?)
                THEN strftime('%Y-%m-%dT%H:%M:%SZ', submitted_at) END AS sub_at,
           CASE WHEN won_at IS NOT NULL AND datetime(won_at) >= datetime(?)
                THEN strftime('%Y-%m-%dT%H:%M:%SZ', won_at) END AS win_at
    FROM estimates
    WHERE deleted_at IS NULL
      AND is_alternate = 0
      AND (bid_type = 'real' OR bid_type IS NULL)
      AND (datetime(submitted_at) >= datetime(?) OR datetime(won_at) >= datetime(?))
    ORDER BY id ASC
    LIMIT 50
  `).all(since, since, since, since);

  const events = [];
  for (const r of rows) {
    const base = { id: r.id, bid_number: r.bid_number, project_name: r.project_name, client_gc: r.client_gc };
    if (r.sub_at) events.push({ ...base, type: 'submitted', at: r.sub_at, key: r.id + ':submitted' });
    if (r.win_at) events.push({ ...base, type: 'won', at: r.win_at, key: r.id + ':won' });
  }
  events.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  res.json({ now, events });
});

// Sales tax owed per Won job (admin only). Sales tax is a pass-through we
// collect and remit, so the dashboard reports pre-tax; this is the one place
// tax is totaled. Mirrors the same visibility filters as /summary.
router.get('/tax-summary', (req, res) => {
  if (!isAdminish(req.user.role)) return res.status(403).json({ error: 'Admin only' });
  const idRows = db.prepare("SELECT id FROM estimates WHERE status = 'Won' AND deleted_at IS NULL AND confirmed = 1 AND is_alternate = 0 AND (bid_type = 'real' OR bid_type IS NULL)").all();
  const rows = [];
  for (const { id } of idRows) {
    const bundle = loadFullEstimate(id);
    if (!bundle) continue;
    const e = bundle.estimate;
    const c = bundle.computed || {};
    const pc = bundle.processComputed || {};
    const isPO = e.job_type === 'process_only';
    let taxBase, taxRate, taxAmount;
    if (isPO) {
      taxBase = (+pc.subTotal || 0) + (+pc.opAmt || 0);
      taxRate = +e.po_tax_pct || 0;
      taxAmount = +pc.taxAmt || 0;
    } else {
      const t = c.tax || {};
      taxBase = +t.base || 0;
      taxRate = +t.rate || 0;
      taxAmount = +t.amount || 0;
    }
    rows.push({
      id: e.id,
      project_name: e.project_name || '',
      bid_number: e.bid_number || '',
      job_number: e.job_number || '',
      client_gc: e.client_gc || '',
      job_type: e.job_type || 'full',
      won_at: e.won_at || null,
      tax_base: taxBase,
      tax_rate: taxRate,
      tax_amount: taxAmount
    });
  }
  res.json({ rows });
});

// ---- CREATE ----
router.post('/', (req, res) => {
  const stmt = db.prepare(`INSERT INTO estimates
    (processing_rate, fab_rate, paint_rate, consumables_rate, handling_rate, galv_rate, created_by, confirmed)
    VALUES (0, 85, 0.08, 0.03, 0.05, 1.00, ?, 1)`);
  const info = stmt.run(req.user.userId);
  const id = info.lastInsertRowid;
  if (req.body && Object.keys(req.body).length) {
    applyUpdate(id, req.body);
  }
  // Seed default rows for a brand-new process-only estimate.
  if (req.body && req.body.job_type === 'process_only') {
    seedProcessOnlyDefaults(id);
  }
  // Default Prepared By to the signed-in user's name.
  if (req.user && req.user.name) {
    db.prepare("UPDATE estimates SET prepared_by = ? WHERE id = ? AND (prepared_by IS NULL OR prepared_by = '')").run(req.user.name, id);
  }
  // Seed proposal Notes/Terms from the admin-set defaults (settings_kv), only when empty.
  seedProposalDefaults(id);
  const bundle = loadFullEstimate(id);
  res.status(201).json(bundle);
});

// Copy the admin-configured default proposal Notes and Terms into a new estimate.
// Only fills a field that is currently empty so it never clobbers anything the
// caller already provided. Blank defaults are skipped, leaving legacy behavior intact.
function seedProposalDefaults(id) {
  const getKv = (key) => {
    const row = db.prepare('SELECT value FROM settings_kv WHERE key = ?').get(key);
    return row && row.value != null ? String(row.value) : '';
  };
  const notes = getKv('proposal_default_notes');
  const terms = getKv('proposal_default_terms');
  if (notes.trim()) {
    db.prepare("UPDATE estimates SET proposal_notes = ? WHERE id = ? AND (proposal_notes IS NULL OR proposal_notes = '')").run(notes, id);
  }
  if (terms.trim()) {
    db.prepare("UPDATE estimates SET proposal_terms = ? WHERE id = ? AND (proposal_terms IS NULL OR proposal_terms = '')").run(terms, id);
  }
}

// Default line items and additional costs for a new process-only estimate,
// matching the RR "Process Only" Excel template.
const PO_DEFAULT_LINES = [
  ['Columns Process & Fabricate', 'pf', 0],
  ['Beams Process & Fabricate', 'pf', 0],
  ['Beams Process Only', 'proc', 0],
  ['Vertical Braces', 'pf', 1],
  ['Angles Process', 'proc', 0],
  ['Channels Process', 'proc', 0],
  ['Angle roof frames', 'pf', 0],
  ['Channels Process & Fabricate', 'pf', 0],
  ['Tubes Process & Fabrication', 'manual', 0]
];
const PO_DEFAULT_ADDCOSTS = [
  ['Plate Processing for Fab', 'lbs', 0.05, 0],
  ['Angles Processing for Fab', 'lbs', 1, 0],
  ['Tubes Process for Fab', 'lbs', 1, 0],
  ['W shapes Process for Fab', 'lbs', 140, 0],
  ['Consumables', 'lbs', 0.05, 0],
  ['Trucking', 'loads', 2500, 0],
  ['Paint', 'lbs', 0.02, 0],
  ['Galvanize', 'lbs', 0.65, 0],
  ['Other / Misc', 'flat $', 0, 1],
  // [name, unit, rate, is_flat, is_labor] — Shop Labor keeps its margin: it bills
  // at hours x rate but costs at the estimate cost rate (see lib/calc_process.js).
  ['Shop Labor', 'hrs', 85, 0, 1]
];
function seedProcessOnlyDefaults(id) {
  const lineIns = db.prepare(`INSERT INTO process_only_lines
    (estimate_id, position, name, line_type, qty, labor_hrs, weight_lb, galv_on, proc_manual)
    VALUES (?, ?, ?, ?, 0, 0, 0, ?, 0)`);
  const addIns = db.prepare(`INSERT INTO process_only_addcosts
    (estimate_id, position, name, unit, input_qty, rate, is_flat, is_labor)
    VALUES (?, ?, ?, ?, 0, ?, ?, ?)`);
  const tx = db.transaction(() => {
    PO_DEFAULT_LINES.forEach((r, i) => lineIns.run(id, i + 1, r[0], r[1], r[2]));
    PO_DEFAULT_ADDCOSTS.forEach((r, i) => addIns.run(id, i + 1, r[0], r[1], r[2], r[3], r[4] || 0));
  });
  tx();
}

// ---- GET ----
router.get('/:id', (req, res) => {
  const includeDeleted = req.query.includeDeleted === '1' || req.query.includeDeleted === 'true';
  const bundle = loadFullEstimate(Number(req.params.id), { includeDeleted });
  if (!bundle) return res.status(404).json({ error: 'not found' });
  res.json(bundle);
});

// ---- Estimate locks ----
// One row in estimate_locks means someone is actively editing that estimate.
// A lock is "stale" (treated as free) once last_seen is older than
// LOCK_STALE_SECONDS. The frontend refreshes last_seen with a heartbeat while
// the editor is open, and releases the lock when it closes. Admins/superadmins
// can force-release anyone's lock.
const LOCK_STALE_SECONDS = 120;

// Returns the active (non-stale) lock for an estimate, or null if free/stale.
function activeLock(estimateId) {
  const row = db.prepare(
    "SELECT estimate_id, user_id, user_name, locked_at, last_seen, " +
    "CAST((julianday('now') - julianday(last_seen)) * 86400 AS INTEGER) AS age_seconds " +
    "FROM estimate_locks WHERE estimate_id = ?"
  ).get(estimateId);
  if (!row) return null;
  if (row.age_seconds >= LOCK_STALE_SECONDS) return null;
  return row;
}

// Acquire or refresh a lock (also serves as the heartbeat).
// Returns { ok: true } if you now hold it, or { ok: false, lockedBy, lockedAt }
// if someone else holds a fresh lock.
router.post('/:id/lock', (req, res) => {
  const id = Number(req.params.id);
  const me = req.user || {};
  const existing = activeLock(id);
  if (existing && existing.user_id !== me.userId) {
    return res.json({ ok: false, lockedBy: existing.user_name || 'another user', lockedAt: existing.locked_at });
  }
  if (existing && existing.user_id === me.userId) {
    db.prepare("UPDATE estimate_locks SET last_seen = datetime('now') WHERE estimate_id = ?").run(id);
  } else {
    db.prepare(
      "INSERT INTO estimate_locks (estimate_id, user_id, user_name, locked_at, last_seen) " +
      "VALUES (?,?,?,datetime('now'),datetime('now')) " +
      "ON CONFLICT(estimate_id) DO UPDATE SET " +
      "user_id=excluded.user_id, user_name=excluded.user_name, locked_at=datetime('now'), last_seen=datetime('now')"
    ).run(id, me.userId, me.name || '');
  }
  res.json({ ok: true });
});

// Release a lock. You can release your own; admins/superadmins can force-release
// anyone's (used by the "Take over" button).
router.delete('/:id/lock', (req, res) => {
  const id = Number(req.params.id);
  const me = req.user || {};
  const existing = db.prepare('SELECT user_id FROM estimate_locks WHERE estimate_id = ?').get(id);
  if (!existing) return res.json({ ok: true });
  const isAdmin = me.role === 'admin' || me.role === 'superadmin';
  if (existing.user_id !== me.userId && !isAdmin) {
    return res.status(403).json({ error: 'not your lock' });
  }
  db.prepare('DELETE FROM estimate_locks WHERE estimate_id = ?').run(id);
  res.json({ ok: true });
});

// ---- UPDATE ----
router.put('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const prev = db.prepare('SELECT id, status FROM estimates WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!prev) return res.status(404).json({ error: 'not found' });
  // Don't let a second person overwrite an estimate that someone else has open.
  const lock = activeLock(id);
  if (lock && lock.user_id !== (req.user && req.user.userId)) {
    return res.status(423).json({ error: 'This bid is being edited by ' + (lock.user_name || 'another user') });
  }

  // --- Job-number gate ---
  // A bid cannot move into Won without a valid, unique job number. Enforced here
  // (not just in the UI) so it holds no matter which screen triggers the win:
  // the list status dropdown, the Project tab dropdown, or the editor button.
  // Format depends on job_type: full = NNNN-NNNN (1234-5678), process-only = P-000.
  let gatedJobNumber = null;
  if (((req.body || {}).status === 'Won') && prev.status !== 'Won') {
    const grow = db.prepare('SELECT job_type, job_number, bid_number FROM estimates WHERE id = ?').get(id);
    const jobType = (grow && grow.job_type) || 'full';
    const hasIncoming = Object.prototype.hasOwnProperty.call(req.body || {}, 'job_number');
    const candidate = String((hasIncoming ? req.body.job_number : (grow && grow.job_number)) || '').trim();
    const pattern = jobType === 'process_only' ? /^P-\d{3}(-\d{1,2})?$/ : /^\d{4}-\d{4}$/;
    if (!pattern.test(candidate)) {
      return res.status(400).json({
        error: jobType === 'process_only'
          ? 'A job number (P- followed by 3 digits, optionally -1/-2/-3 for a phase) is required to mark this bid Won.'
          : 'A job number (4 digits, a dash, then 4 digits, e.g. 1234-5678) is required to mark this bid Won.'
      });
    }
    // Uniqueness is checked against OTHER job families. Revisions of the same job
    // (same bid-number base, e.g. 2005 / 2005.1) deliberately share one number,
    // so a blanket UNIQUE index can't be used; we exclude this job's own base.
    const base = String((grow && grow.bid_number) || '').split('.')[0];
    const dupSql = 'SELECT id FROM estimates WHERE job_number = ? AND deleted_at IS NULL AND is_alternate = 0 AND id != ?'
      + (base ? ' AND bid_number != ? AND bid_number NOT LIKE ?' : '');
    const dupArgs = base ? [candidate, id, base, base + '.%'] : [candidate, id];
    if (db.prepare(dupSql).get(...dupArgs)) {
      return res.status(409).json({ error: candidate + ' is already assigned to another job.' });
    }
    gatedJobNumber = candidate;
  }

  applyUpdate(id, req.body || {});
  // Assign a bid number the first time an estimate is confirmed (saved).
  const cur = db.prepare('SELECT confirmed, bid_number FROM estimates WHERE id = ?').get(id);
  if (cur && cur.confirmed === 1 && (!cur.bid_number || String(cur.bid_number).trim() === '')) {
    db.prepare('UPDATE estimates SET bid_number = ? WHERE id = ?').run(nextBidNumber(), id);
  }

  // Status is a job-level attribute: when it changes, every version of the same
  // job (same bid-number base) travels together so revisions never drift apart.
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'status')) {
    const meRow = db.prepare('SELECT bid_number FROM estimates WHERE id = ?').get(id);
    const base = String((meRow && meRow.bid_number) || '').split('.')[0];
    if (base) {
      db.prepare("UPDATE estimates SET status = ?, updated_at = datetime('now') WHERE (bid_number = ? OR bid_number LIKE ?) AND id != ? AND deleted_at IS NULL AND is_alternate = 0").run(req.body.status, base, base + '.%', id);
    }
  }

  const bundle = loadFullEstimate(id);

  // On transition to Won: auto-generate SOV if not already present, then email recipients
  const newStatus = (req.body || {}).status;
  if (newStatus === 'Won' && prev.status !== 'Won') {
    // Stamp the date this bid was marked Won (drives the dashboard Won card time filter)
    db.prepare("UPDATE estimates SET won_at = datetime('now') WHERE id = ?").run(id);
    // Persist the gated job number, stamp who/when assigned it, and push the same
    // number onto every version of this job family so revisions inherit it.
    if (gatedJobNumber) {
      db.prepare("UPDATE estimates SET job_number = ?, job_number_assigned_by = ?, job_number_assigned_at = datetime('now') WHERE id = ?")
        .run(gatedJobNumber, (req.user && req.user.userId) || null, id);
      const famRow = db.prepare('SELECT bid_number FROM estimates WHERE id = ?').get(id);
      const famBase = String((famRow && famRow.bid_number) || '').split('.')[0];
      if (famBase) {
        db.prepare("UPDATE estimates SET job_number = ? WHERE (bid_number = ? OR bid_number LIKE ?) AND id != ? AND deleted_at IS NULL")
          .run(gatedJobNumber, famBase, famBase + '.%', id);
      }
    }
    const existingSov = db.prepare('SELECT id FROM sov_items WHERE estimate_id = ? LIMIT 1').get(id);
    // Pre-seed only for full-project jobs. buildSovItems uses full-project totals,
    // so for process-only it would write zero-value lines and then block the
    // /sov route (which has the process-only math) from generating correctly.
    // Leaving process-only unseeded lets the SOV tab generate it properly on open.
    if (!existingSov && bundle.estimate.job_type !== 'process_only') {
      const sovItems = buildSovItems(bundle);
      const ins = db.prepare(
        'INSERT INTO sov_items (estimate_id, item_no, description, scheduled_value, position) VALUES (?,?,?,?,?)'
      );
      const tx = db.transaction(arr => {
        for (const it of arr) ins.run(id, it.item_no, it.description, it.scheduled_value, it.position);
      });
      tx(sovItems);
    }
    // Notify recipients (fire-and-forget, don't block response)
    const recipients = db.prepare('SELECT email, name FROM notification_recipients WHERE active = 1').all();
    console.log(`[won] bid ${id} marked Won; notifying ${recipients.length} active recipient(s):`, recipients.map(r => r.email).join(', ') || '(none)');
    sendWonNotification(bundle, recipients).catch(err => console.error('[won] email error:', err));
    // Push this won job to the Project Tracker in real time. Fire-and-forget, and
    // reloaded so it carries the freshly assigned job number and won_at stamp.
    try { pushWonJobToTracker(loadFullEstimate(id)); } catch (e) { console.error('[tracker push] error:', e.message); }
  }

  res.json(bundle);
});

function applyUpdate(id, body) {
  const sets = [];
  const vals = [];
  // While a bid is still a Draft, treat every save as "last worked on" and bump
  // proposal_date to today, so it keeps advancing until the bid is Submitted,
  // Resubmitted, or Revised (those routes own the date from that point on). If
  // the caller passed an explicit proposal_date, we respect it below instead of
  // overriding it. Look this up before building the update so a status change in
  // the same body doesn't affect the decision.
  const cur = db.prepare('SELECT status FROM estimates WHERE id = ?').get(id);
  const bumpProposalDate =
    cur && cur.status === 'Draft' &&
    !Object.prototype.hasOwnProperty.call(body, 'proposal_date');
  // Bids are quoted in whole dollars. When a manual quote field is present and
  // holds a numeric value, round it up to the next dollar so stored quotes never
  // carry cents. An empty string stays empty (means "use the computed total").
  const ROUND_UP_COLS = new Set(['price_to_win', 'client_quote_amount']);
  for (const k of EST_COLS) {
    if (Object.prototype.hasOwnProperty.call(body, k)) {
      let v = body[k];
      if (ROUND_UP_COLS.has(k) && v !== null && v !== '' && !isNaN(+v)) {
        v = Math.ceil(+v);
      }
      sets.push(`${k} = ?`);
      vals.push(v);
    }
  }
  if (bumpProposalDate) {
    const todayDate = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    sets.push('proposal_date = ?');
    vals.push(todayDate);
  }
  if (sets.length) {
    sets.push("updated_at = datetime('now')");
    vals.push(id);
    db.prepare(`UPDATE estimates SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }
}

// ---- DELETE ----
router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  const prev = db.prepare('SELECT id FROM estimates WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!prev) return res.status(404).json({ error: 'not found' });
  db.prepare("UPDATE estimates SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(id);
  // An alternate has no meaning without its parent: soft-delete them together.
  db.prepare("UPDATE estimates SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE parent_estimate_id = ? AND is_alternate = 1 AND deleted_at IS NULL").run(id);
  res.json({ deleted: id });
});


// ---- RESTORE (undo soft-delete) ----
router.post('/:id/restore', (req, res) => {
  const id = Number(req.params.id);
  const est = db.prepare('SELECT id, created_by, deleted_at FROM estimates WHERE id = ?').get(id);
  if (!est || !est.deleted_at) return res.status(404).json({ error: 'not found' });
  // Non-admins may only restore their own (or legacy ownerless) bids.
  if (!isAdminish(req.user.role) && est.created_by !== null && est.created_by !== req.user.userId) {
    return res.status(403).json({ error: 'Access denied.' });
  }
  db.prepare("UPDATE estimates SET deleted_at = NULL, updated_at = datetime('now') WHERE id = ?").run(id);
  // Bring back alternates that were soft-deleted together with this parent.
  db.prepare("UPDATE estimates SET deleted_at = NULL, updated_at = datetime('now') WHERE parent_estimate_id = ? AND is_alternate = 1 AND deleted_at IS NOT NULL").run(id);
  res.json({ restored: id });
});


// ---- MARK COUNTED (which version of a job counts on the dashboard) ----
router.post('/:id/mark-counted', (req, res) => {
  const id = Number(req.params.id);
  const est = db.prepare('SELECT id, bid_number, created_by FROM estimates WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!est) return res.status(404).json({ error: 'not found' });
  if (!isAdminish(req.user.role) && est.created_by !== null && est.created_by !== req.user.userId) {
    return res.status(403).json({ error: 'Access denied.' });
  }
  const base = String(est.bid_number || '').split('.')[0];
  const tx = db.transaction(() => {
    if (base) {
      // Every other version of the same job drops out of dashboard totals...
      db.prepare("UPDATE estimates SET bid_type = 'superseded', updated_at = datetime('now') WHERE (bid_number = ? OR bid_number LIKE ?) AND deleted_at IS NULL AND is_alternate = 0").run(base, base + '.%');
    }
    // ...and the chosen one becomes the live, counted bid.
    db.prepare("UPDATE estimates SET bid_type = 'real', updated_at = datetime('now') WHERE id = ?").run(id);
  });
  tx();
  res.json({ counted: id });
});


// ---- SUBMIT ----
router.post('/:id/submit', async (req, res) => {
  const id = Number(req.params.id);
  const est = db.prepare('SELECT id, proposal_date FROM estimates WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!est) return res.status(404).json({ error: 'not found' });

  // Set proposal_date if not already set, then update status and submitted_at
  const now = new Date().toISOString();
  const todayDate = now.split('T')[0]; // YYYY-MM-DD format
  const proposalDate = est.proposal_date || todayDate;

  db.prepare(`
    UPDATE estimates
    SET status = 'Submitted',
        confirmed = 1,
        submitted_at = ?,
        proposal_date = ?,
        updated_at = datetime('now')
    WHERE id = ?
  `).run(now, proposalDate, id);

  // Baseline snapshot of the bid's priced inputs, so the first resubmit can
  // diff against it. Never let a snapshot failure break submit.
  try {
    db.prepare('UPDATE estimates SET submit_snapshot = ? WHERE id = ?')
      .run(JSON.stringify(buildSnapshot(db, id)), id);
  } catch (e) { console.error('[submit] snapshot error:', e.message); }

  const bundle = loadFullEstimate(id);
  // Test/Demo bids exist only for trying things out: they never notify anyone
  // and never count in dashboard totals. Skip the email entirely for them.
  const bidType = bundle.estimate && bundle.estimate.bid_type;
  const isTestLike = bidType === 'test' || bidType === 'demo';
  const recipients = isTestLike
    ? []
    : db.prepare('SELECT email, name FROM notification_recipients WHERE active = 1').all();

  if (!isTestLike) {
    // Send email notification (fire-and-forget)
    sendReadyToSubmit(bundle, recipients).catch(err => console.error('[submit] email error:', err));
  }

  // Return bundle with notification info (send doesn't wait for email)
  res.json({
    ...bundle,
    notification: isTestLike
      ? { ok: true, sent: 0, skipped: bidType + ' bid — no notification sent' }
      : { ok: true, sent: recipients.length }
  });
});

// ---- RESUBMIT ----
// Lightweight, in-place re-issue of a bid that is already Submitted, for a quick
// change the GC asked for. Unlike Revise (which clones a new .N revision), this
// keeps the SAME bid number and status. It bumps the proposal date to today (the
// resubmit date) so the regenerated PDF carries the new date, records a required
// reason plus who/when in the resubmit log, and re-emails the recipients. It does
// NOT touch submitted_at, so the original submission timestamp is preserved.
router.post('/:id/resubmit', async (req, res) => {
  const id = Number(req.params.id);
  const note = String((req.body || {}).note || '').trim();
  if (!note) {
    return res.status(400).json({ error: 'A reason for the change is required to resubmit.' });
  }
  const est = db.prepare('SELECT id, status FROM estimates WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!est) return res.status(404).json({ error: 'not found' });
  if (est.status !== 'Submitted') {
    return res.status(400).json({ error: 'Only a Submitted bid can be resubmitted.' });
  }

  const now = new Date().toISOString();
  const todayDate = now.split('T')[0]; // YYYY-MM-DD — the resubmit date

  // Auto-detect what changed since the last submit/resubmit by diffing the prior
  // snapshot against the current inputs. Read-only and defensive: any failure
  // just yields an empty change list and never blocks the resubmit.
  let changes = [];
  let newSnapshot = null;
  try {
    const prevRow = db.prepare('SELECT submit_snapshot FROM estimates WHERE id = ?').get(id);
    const current = buildSnapshot(db, id);
    newSnapshot = JSON.stringify(current);
    if (prevRow && prevRow.submit_snapshot) {
      changes = diffSnapshots(JSON.parse(prevRow.submit_snapshot), current);
    }
  } catch (e) { console.error('[resubmit] diff error:', e.message); changes = []; }

  const tx = db.transaction(() => {
    // Bump the proposal date to today; leave submitted_at (original submit) alone.
    db.prepare(`
      UPDATE estimates
      SET proposal_date = ?,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(todayDate, id);
    // Audit entry: required reason + who + when (server clock) + detected changes.
    db.prepare(`
      INSERT INTO estimate_resubmits (estimate_id, note, user_id, user_name, created_at, changes)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, note, (req.user && req.user.userId) || null, (req.user && req.user.name) || '', now, JSON.stringify(changes));
    // Refresh the baseline so the NEXT resubmit diffs against this state.
    if (newSnapshot) {
      db.prepare('UPDATE estimates SET submit_snapshot = ? WHERE id = ?').run(newSnapshot, id);
    }
  });
  tx();

  const bundle = loadFullEstimate(id);
  // Same recipient rules as the initial submit: Test/Demo bids notify no one.
  const bidType = bundle.estimate && bundle.estimate.bid_type;
  const isTestLike = bidType === 'test' || bidType === 'demo';
  const recipients = isTestLike
    ? []
    : db.prepare('SELECT email, name FROM notification_recipients WHERE active = 1').all();

  if (!isTestLike) {
    const userName = (req.user && req.user.name) || '';
    sendResubmitNotification(bundle, recipients, { note, userName, changes })
      .catch(err => console.error('[resubmit] email error:', err));
  }

  res.json({
    ...bundle,
    notification: isTestLike
      ? { ok: true, sent: 0, skipped: bidType + ' bid — no notification sent' }
      : { ok: true, sent: recipients.length }
  });
});

// ---- RESUBMIT PREVIEW (read-only) ----
// Powers the "what's about to be resubmitted" panel in the resubmit dialog:
// a small summary plus the change list that WOULD be recorded, diffed against
// the last submission. Writes nothing.
router.get('/:id/resubmit-preview', (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT id, status, submit_snapshot FROM estimates WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!row) return res.status(404).json({ error: 'not found' });

  let changes = [];
  const hasBaseline = !!row.submit_snapshot;
  try {
    if (row.submit_snapshot) {
      changes = diffSnapshots(JSON.parse(row.submit_snapshot), buildSnapshot(db, id));
    }
  } catch (e) { console.error('[resubmit-preview] diff error:', e.message); changes = []; }

  let summary = {};
  try {
    const bundle = loadFullEstimate(id);
    const e = bundle.estimate || {};
    const isPO = e.job_type === 'process_only';
    let sellPrice = 0;
    try {
      if (isPO) sellPrice = (bundle.processComputed && bundle.processComputed.quoted) || 0;
      else { const view = buildProposalView(bundle); sellPrice = (view && view.subtotal) || 0; }
    } catch (e2) { sellPrice = 0; }
    summary = {
      project_name: e.project_name || '', bid_number: e.bid_number || '',
      client_gc: e.client_gc || '', sell_price: sellPrice
    };
  } catch (e) { summary = {}; }

  res.json({ status: row.status, hasBaseline, changes, summary });
});

// ---- CLONE ----
// Copy every child-table row from one estimate to another. This is exactly the
// set of inserts the clone route has always done, pulled into a helper so both
// a base bid and its alternates can be cloned the same way.
function copyEstimateChildren(srcId, newId) {
  db.prepare(`
    INSERT INTO material_overrides (estimate_id, section, weight_lb, cost_per_cwt)
    SELECT ?, section, weight_lb, cost_per_cwt FROM material_overrides WHERE estimate_id = ?
  `).run(newId, srcId);
  db.prepare(`
    INSERT INTO takeoff_shapes (estimate_id, section_type, position, section_name, cost_factor, drop_ft, l1,l2,l3,l4,l5,l6,l7,l8, drawing, notes, manual_wpf)
    SELECT ?, section_type, position, section_name, cost_factor, drop_ft, l1,l2,l3,l4,l5,l6,l7,l8, drawing, notes, manual_wpf FROM takeoff_shapes WHERE estimate_id = ?
  `).run(newId, srcId);
  db.prepare(`
    INSERT INTO takeoff_plates (estimate_id, position, thickness, cost_factor, width_in, length_in, qty, notes)
    SELECT ?, position, thickness, cost_factor, width_in, length_in, qty, notes FROM takeoff_plates WHERE estimate_id = ?
  `).run(newId, srcId);
  db.prepare(`
    INSERT INTO takeoff_misc (estimate_id, position, description, qty, weight_each_lb, cost_per_cwt, notes, length_ft, price_per_ft)
    SELECT ?, position, description, qty, weight_each_lb, cost_per_cwt, notes, length_ft, price_per_ft FROM takeoff_misc WHERE estimate_id = ?
  `).run(newId, srcId);
  db.prepare(`
    INSERT INTO wage_rates (estimate_id, role, base_rate, cash_in_lieu, fica_pct, futa_pct, suta_pct, wc_pct, gl_pct, umbrella_pct, auto_pct, pp_bond_pct, health_welfare, pension, consumables_pct, fuel_pct, ohp_pct)
    SELECT ?, role, base_rate, cash_in_lieu, fica_pct, futa_pct, suta_pct, wc_pct, gl_pct, umbrella_pct, auto_pct, pp_bond_pct, health_welfare, pension, consumables_pct, fuel_pct, ohp_pct FROM wage_rates WHERE estimate_id = ?
  `).run(newId, srcId);
  db.prepare(`
    INSERT INTO process_only_lines (estimate_id, position, name, line_type, qty, labor_hrs, weight_lb, galv_on, proc_manual)
    SELECT ?, position, name, line_type, qty, labor_hrs, weight_lb, galv_on, proc_manual FROM process_only_lines WHERE estimate_id = ?
  `).run(newId, srcId);
  db.prepare(`
    INSERT INTO process_only_addcosts (estimate_id, position, name, unit, input_qty, rate, is_flat, is_labor)
    SELECT ?, position, name, unit, input_qty, rate, is_flat, is_labor FROM process_only_addcosts WHERE estimate_id = ?
  `).run(newId, srcId);
}

// Clone one estimate row (all saveable columns except submitted_at and
// proposal_date) plus all its child rows. Returns the new id. Status is forced
// to Draft and the project name gets an optional suffix, matching the original
// clone behavior exactly. proposal_date is excluded so it comes in NULL and gets
// stamped fresh on next submit/download, just like submitted_at.
function cloneEstimateRow(src, projectSuffix) {
  const cols = EST_COLS.filter(c => c !== 'submitted_at' && c !== 'proposal_date');
  const placeholders = cols.map(() => '?').join(',');
  const vals = cols.map(c => c === 'status' ? 'Draft' : (c === 'project_name' ? (src[c] || '') + (projectSuffix || '') : src[c]));
  const result = db.prepare(`INSERT INTO estimates (${cols.join(',')}) VALUES (${placeholders})`).run(...vals);
  const newId = result.lastInsertRowid;
  copyEstimateChildren(src.id, newId);
  return newId;
}

router.post('/:id/clone', (req, res) => {
  const id = Number(req.params.id);
  const src = db.prepare('SELECT * FROM estimates WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!src) return res.status(404).json({ error: 'not found' });

  const suffix = src.status === 'Submitted' ? ' (rev)' : ' (copy)';
  let newId;
  const tx = db.transaction(() => {
    newId = cloneEstimateRow(src, suffix);

    // Bid numbering: a revision (clone of a submitted/won/lost bid, or an
    // explicit Revise request) gets the parent's base number with the next .N
    // suffix and is shown immediately. A plain copy is a brand-new job: it is
    // saved immediately with its own new bid number so it can't be lost by
    // navigating away, and any inherited job number is cleared.
    const forceRevision = !!(req.body && req.body.revision === true);
    const isRevision = forceRevision || src.status === 'Submitted' || src.status === 'Won' || src.status === 'Lost';
    if (isRevision) {
      const base = String(src.bid_number || '').split('.')[0] || nextBidNumber();
      // The new revision is the live bid and always counts in dashboard totals.
      db.prepare("UPDATE estimates SET bid_number = ?, confirmed = 1, status = 'Draft', bid_type = 'real', revised_from_id = ? WHERE id = ?").run(nextRevision(base), src.id, newId);
      // The bid it supersedes drops out of totals so the same job is not counted
      // twice. If a revision is later abandoned, re-mark bid types by hand.
      db.prepare("UPDATE estimates SET bid_type = 'superseded' WHERE id = ?").run(src.id);
    } else {
      db.prepare("UPDATE estimates SET bid_number = ?, confirmed = 1, job_number = NULL WHERE id = ?").run(nextBidNumber(), newId);
    }

    // Bring alternates along: clone each alternate of the source base bid and
    // attach the fresh copy to the new parent. Only base bids carry alternates.
    if (!src.is_alternate) {
      const alts = db.prepare(
        'SELECT * FROM estimates WHERE parent_estimate_id = ? AND is_alternate = 1 AND deleted_at IS NULL ORDER BY alt_position, id'
      ).all(id);
      for (const alt of alts) {
        const newAltId = cloneEstimateRow(alt, '');
        db.prepare(
          "UPDATE estimates SET is_alternate = 1, parent_estimate_id = ?, bid_number = '', confirmed = 1 WHERE id = ?"
        ).run(newId, newAltId);
      }
    }
  });
  tx();

  res.status(201).json(loadFullEstimate(newId));
});

// ---- ALTERNATES ----
// An alternate is a full estimate record linked to a parent base bid, so it
// reuses every other estimate endpoint (takeoff, cost inputs, calc, proposal).
// These routes only create, list, and remove alternates under a parent. Editing
// an alternate (including renaming it via alt_label) uses the normal estimate
// endpoints with the alternate's own id.

// List alternates for a base bid, each with its computed sell price.
router.get('/:id/alternates', (req, res) => {
  const id = Number(req.params.id);
  const rows = db.prepare(
    'SELECT id, alt_label, alt_position, job_type, status FROM estimates WHERE parent_estimate_id = ? AND is_alternate = 1 AND deleted_at IS NULL ORDER BY alt_position, id'
  ).all(id);
  const alternates = rows.map(r => {
    const bundle = loadFullEstimate(r.id);
    const c = bundle ? (bundle.computed || {}) : {};
    const pc = bundle ? (bundle.processComputed || {}) : {};
    const isPO = (r.job_type === 'process_only');
    const price = isPO ? (+pc.quoted || 0) : (+c.totalBid || 0);
    return {
      id: r.id,
      alt_label: r.alt_label || '',
      alt_position: r.alt_position || 0,
      job_type: r.job_type || 'full',
      status: r.status || 'Draft',
      price
    };
  });
  res.json({ alternates });
});

// Create a new blank alternate under a base bid, inheriting the parent's job type
// and the same default rates a brand-new estimate gets.
router.post('/:id/alternates', (req, res) => {
  const id = Number(req.params.id);
  const parent = db.prepare('SELECT * FROM estimates WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!parent) return res.status(404).json({ error: 'not found' });
  if (parent.is_alternate) return res.status(400).json({ error: 'cannot add an alternate to an alternate' });

  const jobType = parent.job_type || 'full';
  const maxPos = db.prepare(
    'SELECT COALESCE(MAX(alt_position), 0) AS m FROM estimates WHERE parent_estimate_id = ? AND is_alternate = 1 AND deleted_at IS NULL'
  ).get(id).m;
  const label = (req.body && typeof req.body.alt_label === 'string' && req.body.alt_label.trim())
    ? req.body.alt_label.trim()
    : `Alternate ${maxPos + 1}`;

  const stmt = db.prepare(`INSERT INTO estimates
    (processing_rate, fab_rate, paint_rate, consumables_rate, handling_rate, galv_rate, created_by, confirmed,
     is_alternate, parent_estimate_id, alt_label, alt_position, job_type, status)
    VALUES (0, 85, 0.08, 0.03, 0.05, 1.00, ?, 1, 1, ?, ?, ?, ?, 'Draft')`);
  const info = stmt.run(req.user.userId, id, label, maxPos + 1, jobType);
  const altId = info.lastInsertRowid;
  if (jobType === 'process_only') seedProcessOnlyDefaults(altId);
  // Inherit the base bid's project identity so an alternate needs no project tab.
  db.prepare("UPDATE estimates SET project_name = ?, client_gc = ?, bid_date = ?, job_number = ?, prepared_by = ? WHERE id = ?")
    .run(parent.project_name || '', parent.client_gc || '', parent.bid_date || '', parent.job_number || '', parent.prepared_by || '', altId);
  res.status(201).json(loadFullEstimate(altId));
});

// Remove an alternate (soft delete). Must belong to the given parent.
router.delete('/:id/alternates/:altId', (req, res) => {
  const id = Number(req.params.id);
  const altId = Number(req.params.altId);
  const alt = db.prepare(
    'SELECT id FROM estimates WHERE id = ? AND parent_estimate_id = ? AND is_alternate = 1 AND deleted_at IS NULL'
  ).get(altId, id);
  if (!alt) return res.status(404).json({ error: 'not found' });
  db.prepare("UPDATE estimates SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(altId);
  res.json({ ok: true });
});

// ---- MATERIAL OVERRIDES ----
router.put('/:id/material/:section', (req, res) => {
  const id = Number(req.params.id);
  const section = String(req.params.section).toUpperCase();
  const { weight_lb, cost_per_cwt, source } = req.body || {};
  const src = source || 'manual';
  if (src === 'takeoff' ||
      ((weight_lb == null || weight_lb === '' || +weight_lb <= 0)
      && (cost_per_cwt == null || cost_per_cwt === '' || +cost_per_cwt <= 0))) {
    // Switching back to takeoff: set source='takeoff' (keep values for reference but don't use them)
    db.prepare(`
      INSERT INTO material_overrides (estimate_id, section, weight_lb, cost_per_cwt, source)
      VALUES (?, ?, ?, ?, 'takeoff')
      ON CONFLICT(estimate_id, section) DO UPDATE SET source = 'takeoff'
    `).run(id, section, weight_lb || null, cost_per_cwt || null);
  } else {
    db.prepare(`
      INSERT INTO material_overrides (estimate_id, section, weight_lb, cost_per_cwt, source)
      VALUES (?, ?, ?, ?, 'manual')
      ON CONFLICT(estimate_id, section) DO UPDATE SET
        weight_lb = excluded.weight_lb,
        cost_per_cwt = excluded.cost_per_cwt,
        source = 'manual'
    `).run(id, section, weight_lb || null, cost_per_cwt || null);
  }
  db.prepare("UPDATE estimates SET updated_at = datetime('now') WHERE id = ?").run(id);
  res.json(loadFullEstimate(id));
});

// ---- TAKEOFF SHAPES REPLACE ----
router.put('/:id/takeoff/shapes', (req, res) => {
  const id = Number(req.params.id);
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM takeoff_shapes WHERE estimate_id = ?').run(id);
    const insert = db.prepare(`
      INSERT INTO takeoff_shapes (estimate_id, section_type, position, section_name, cost_factor, drop_ft,
        l1,l2,l3,l4,l5,l6,l7,l8, drawing, notes, manual_wpf)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    let pos = 0;
    for (const r of rows) {
      pos += 1;
      insert.run(
        id,
        r.section_type || calc.detectSectionType(r.section_name) || '',
        r.position != null ? r.position : pos,
        r.section_name || '',
        +r.cost_factor || 0,
        +r.drop_ft || 0,
        +r.l1 || 0, +r.l2 || 0, +r.l3 || 0, +r.l4 || 0,
        +r.l5 || 0, +r.l6 || 0, +r.l7 || 0, +r.l8 || 0,
        r.drawing || '',
        r.notes || '',
        +r.manual_wpf || 0
      );
    }
    db.prepare("UPDATE estimates SET updated_at = datetime('now') WHERE id = ?").run(id);
  });
  tx();
  // Auto-release manual overrides for sections that now have takeoff data.
  // This implements "last touched wins": saving takeoff makes it the active source.
  const secsWithData = db.prepare(
    `SELECT DISTINCT section_type FROM takeoff_shapes WHERE estimate_id = ? AND section_name != ''`
  ).all(id).map(r => r.section_type).filter(Boolean);
  for (const sec of secsWithData) {
    db.prepare(
      `INSERT INTO material_overrides (estimate_id, section, weight_lb, cost_per_cwt, source)
       VALUES (?, ?, NULL, NULL, 'takeoff')
       ON CONFLICT(estimate_id, section) DO UPDATE SET source = 'takeoff', weight_lb = NULL, cost_per_cwt = NULL`
    ).run(id, sec);
  }
  // Roll the unique per-piece drawing numbers up to the estimate (for proposal/PDF/SOV).
  const draws = db.prepare("SELECT DISTINCT drawing FROM takeoff_shapes WHERE estimate_id = ? AND drawing != ''").all(id).map(r => r.drawing);
  db.prepare("UPDATE estimates SET drawing_numbers = ? WHERE id = ?").run([...new Set(draws)].join(', '), id);
  res.json(loadFullEstimate(id));
});

// ---- TAKEOFF PLATES REPLACE ----
router.put('/:id/takeoff/plates', (req, res) => {
  const id = Number(req.params.id);
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM takeoff_plates WHERE estimate_id = ?').run(id);
    const insert = db.prepare(`
      INSERT INTO takeoff_plates (estimate_id, position, thickness, cost_factor, width_in, length_in, qty, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    let pos = 0;
    for (const r of rows) {
      pos += 1;
      insert.run(
        id, r.position != null ? r.position : pos,
        r.thickness || '',
        +r.cost_factor || 0,
        +r.width_in || 0,
        +r.length_in || 0,
        +r.qty || 0,
        r.notes || ''
      );
    }
    db.prepare("UPDATE estimates SET updated_at = datetime('now') WHERE id = ?").run(id);
  });
  tx();
  // If any plate rows were saved, auto-release manual override for PL section.
  const hasPlateData = db.prepare(
    `SELECT 1 FROM takeoff_plates WHERE estimate_id = ? AND qty > 0 LIMIT 1`
  ).get(id);
  if (hasPlateData) {
    db.prepare(
      `INSERT INTO material_overrides (estimate_id, section, weight_lb, cost_per_cwt, source)
       VALUES (?, 'PL', NULL, NULL, 'takeoff')
       ON CONFLICT(estimate_id, section) DO UPDATE SET source = 'takeoff', weight_lb = NULL, cost_per_cwt = NULL`
    ).run(id);
  }
  res.json(loadFullEstimate(id));
});

// ---- TAKEOFF MISC METALS REPLACE ----
router.put('/:id/takeoff/misc', (req, res) => {
  const id = Number(req.params.id);
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM takeoff_misc WHERE estimate_id = ?').run(id);
    const insert = db.prepare(`
      INSERT INTO takeoff_misc (estimate_id, position, description, qty, weight_each_lb, cost_per_cwt, notes, length_ft, price_per_ft)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    let pos = 0;
    for (const r of rows) {
      pos += 1;
      insert.run(
        id, r.position != null ? r.position : pos,
        r.description || '',
        +r.qty || 0,
        +r.weight_each_lb || 0,
        +r.cost_per_cwt || 0,
        r.notes || '',
        +r.length_ft || 0,
        +r.price_per_ft || 0
      );
    }
    db.prepare("UPDATE estimates SET updated_at = datetime('now') WHERE id = ?").run(id);
  });
  tx();
  res.json(loadFullEstimate(id));
});

// ---- UPLOAD TAKEOFF FILE (.xlsx template) ----
router.post('/:id/takeoff/upload', upload.single('file'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!req.file) return res.status(400).json({ error: 'file required' });
    const isKiss = /\.kss$/i.test(req.file.originalname || '');
    const parsed = isKiss
      ? parseKissToTakeoff(req.file.buffer.toString('utf8'))
      : await parseTemplate(req.file.buffer, req.file.originalname);
    const mode = String(req.body.mode || 'replace');

    // Apply price book defaults to any row that came in with a zero rate
    const pb = {};
    db.prepare('SELECT section_type, rate_per_cwt FROM price_book').all().forEach(r => { pb[r.section_type] = r.rate_per_cwt; });
    parsed.shapes = parsed.shapes.map((r, idx) => {
      const rate = r.cost_factor || pb[r.section_type] || 0;
      // Warn if a shape has zero rate and empty section_name (likely AISC lookup failed)
      if (rate === 0 && (!r.section_name || r.section_name.trim() === '')) {
        if (!parsed.errors) parsed.errors = [];
        parsed.errors.push('Shape row ' + (idx + 1) + ': AISC lookup failed, add manual weight/ft via Material Overrides');
      }
      return { ...r, cost_factor: rate };
    });
    parsed.plates = parsed.plates.map(r => ({ ...r, cost_factor: r.cost_factor || pb['PLATE'] || 0 }));
    parsed.misc   = (parsed.misc || []).map(r => ({ ...r, cost_per_cwt: r.cost_per_cwt || pb['MISC'] || 0 }));

    const tx = db.transaction(() => {
      if (mode === 'replace') {
        db.prepare('DELETE FROM takeoff_shapes WHERE estimate_id = ?').run(id);
        db.prepare('DELETE FROM takeoff_plates WHERE estimate_id = ?').run(id);
        db.prepare('DELETE FROM takeoff_misc WHERE estimate_id = ?').run(id);
      }
      const startShapePos = mode === 'append'
        ? (db.prepare('SELECT MAX(position) as p FROM takeoff_shapes WHERE estimate_id = ?').get(id).p || 0)
        : 0;
      const startPlatePos = mode === 'append'
        ? (db.prepare('SELECT MAX(position) as p FROM takeoff_plates WHERE estimate_id = ?').get(id).p || 0)
        : 0;
      const startMiscPos = mode === 'append'
        ? (db.prepare('SELECT MAX(position) as p FROM takeoff_misc WHERE estimate_id = ?').get(id).p || 0)
        : 0;

      const shapeInsert = db.prepare(`
        INSERT INTO takeoff_shapes (estimate_id, position, section_type, section_name, cost_factor, drop_ft, l1, l2, l3, l4, l5, l6, l7, l8, drawing, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      (parsed.shapes || []).forEach((r, i) => {
        shapeInsert.run(
          id, startShapePos + i + 1,
          r.section_type || '', r.section_name || '',
          +r.cost_factor || 0, +r.drop_ft || 0,
          +r.l1 || 0, +r.l2 || 0, +r.l3 || 0, +r.l4 || 0,
          +r.l5 || 0, +r.l6 || 0, +r.l7 || 0, +r.l8 || 0,
          r.drawing || '',
          r.notes || ''
        );
      });
      const plateInsert = db.prepare(`
        INSERT INTO takeoff_plates (estimate_id, position, thickness, cost_factor, width_in, length_in, qty, weight_lb, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      (parsed.plates || []).forEach((r, i) => {
        plateInsert.run(
          id, startPlatePos + i + 1,
          r.thickness || '', +r.cost_factor || 0,
          +r.width_in || 0, +r.length_in || 0, +r.qty || 0, +r.weight_lb || 0, r.notes || ''
        );
      });
      const miscInsert = db.prepare(`
        INSERT INTO takeoff_misc (estimate_id, position, description, qty, weight_each_lb, cost_per_cwt, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      (parsed.misc || []).forEach((r, i) => {
        miscInsert.run(
          id, startMiscPos + i + 1,
          r.description || '', +r.qty || 0, +r.weight_each_lb || 0, +r.cost_per_cwt || 0, r.notes || ''
        );
      });
      db.prepare("UPDATE estimates SET updated_at = datetime('now') WHERE id = ?").run(id);
    });
    tx();
    // Auto-release: after upload, flip source to 'takeoff' for any section with data.
    const secsWithData = db.prepare(
      `SELECT DISTINCT section_type FROM takeoff_shapes WHERE estimate_id = ? AND section_name != ''`
    ).all(id).map(r => r.section_type).filter(Boolean);
    for (const sec of secsWithData) {
      db.prepare(
        `INSERT INTO material_overrides (estimate_id, section, weight_lb, cost_per_cwt, source)
         VALUES (?, ?, NULL, NULL, 'takeoff')
         ON CONFLICT(estimate_id, section) DO UPDATE SET source = 'takeoff', weight_lb = NULL, cost_per_cwt = NULL`
      ).run(id, sec);
    }
    const hasPlateData = db.prepare(
      `SELECT 1 FROM takeoff_plates WHERE estimate_id = ? AND qty > 0 LIMIT 1`
    ).get(id);
    if (hasPlateData) {
      db.prepare(
        `INSERT INTO material_overrides (estimate_id, section, weight_lb, cost_per_cwt, source)
         VALUES (?, 'PL', NULL, NULL, 'takeoff')
         ON CONFLICT(estimate_id, section) DO UPDATE SET source = 'takeoff', weight_lb = NULL, cost_per_cwt = NULL`
      ).run(id);
    }

    // Extract drawing numbers from parsed takeoff if available (external format, col B)
    const drawingSet = new Set();
    if (parsed.drawings) {
      parsed.drawings.forEach(d => {
        if (d && d.trim()) drawingSet.add(d.trim());
      });
    }
    const drawingNumbers = Array.from(drawingSet).join(', ');

    // Auto-populate weight fields; capture drawing numbers in their own field
    // (no longer overwrites the user's scope).
    let bundle = loadFullEstimate(id);
    const totalWeight = bundle.computed.materialWeight || 0;
    if (totalWeight > 0) {
      db.prepare(`
        UPDATE estimates
        SET paint_weight = ?, galv_weight = ?, consumables_weight = ?, handling_weight = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(totalWeight, totalWeight, totalWeight, totalWeight, id);
    }
    if (drawingNumbers) {
      db.prepare("UPDATE estimates SET drawing_numbers = ?, updated_at = datetime('now') WHERE id = ?").run(drawingNumbers, id);
    }

    bundle = loadFullEstimate(id);

    // Build human-readable notes so nothing is silently lost on import.
    const notes = [];
    const sk = parsed.skipped;
    if (sk) {
      if (sk.hardware)  notes.push(sk.hardware + ' hardware line(s) skipped (held pending the hardware redesign).');
      if (sk.stainless) notes.push(sk.stainless + ' stainless (SS) line(s) skipped (stainless rates not set up yet).');
      if (sk.aluminum)  notes.push(sk.aluminum + ' aluminum line(s) skipped (aluminum rates not set up yet).');
      const unrec = Object.keys(sk.unrecognized || {});
      if (unrec.length) {
        notes.push('Brought into Misc but please confirm the type: ' +
          unrec.map(k => sk.unrecognized[k] + 'x "' + k + '"').join(', ') + '.');
      }
    }
    // Shapes whose name is not in the AISC table import at zero weight; flag them.
    const noWeight = {};
    (parsed.shapes || []).forEach(s => {
      if (s.section_name && aiscLookup(s.section_name) <= 0) {
        noWeight[s.section_name] = (noWeight[s.section_name] || 0) + 1;
      }
    });
    const nwKeys = Object.keys(noWeight);
    if (nwKeys.length) {
      notes.push('Need a manual weight (not in the AISC table): ' +
        nwKeys.map(k => noWeight[k] + 'x ' + k).join(', ') + '.');
    }

    res.json({ ...bundle, parsed: {
      shapes: (parsed.shapes || []).length,
      plates: (parsed.plates || []).length,
      misc:   (parsed.misc || []).length,
      notes,
      errors: parsed.errors || [],
    }});
  } catch (err) {
    if (err && err.code === 'UNREADABLE_TAKEOFF_FILE') {
      return res.status(400).json({ error: err.userMessage });
    }
    res.status(500).json({ error: err.message });
  }
});

// ---- ASSIGN ESTIMATE ----  (admin/superadmin only)
router.put('/:id/assign', (req, res) => {
  if (!isAdminish(req.user.role)) return res.status(403).json({ error: 'Admin only.' });
  const id = Number(req.params.id);
  const { user_id } = req.body || {};
  // user_id = null means unassign (back to legacy/no-owner)
  db.prepare("UPDATE estimates SET created_by = ? WHERE id = ?").run(user_id || null, id);
  res.json({ ok: true });
});

// ===== PROCESS-ONLY ROUTES =====

// Replace all process-only line items for an estimate.
router.put('/:id/process-lines', (req, res) => {
  const id = Number(req.params.id);
  const rows = Array.isArray(req.body && req.body.rows) ? req.body.rows : [];
  const ins = db.prepare(`INSERT INTO process_only_lines
    (estimate_id, position, name, line_type, qty, labor_hrs, weight_lb, galv_on, proc_manual)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM process_only_lines WHERE estimate_id = ?').run(id);
    rows.forEach((r, i) => ins.run(
      id, +r.position || i + 1, r.name || '', r.line_type || '',
      +r.qty || 0, +r.labor_hrs || 0, +r.weight_lb || 0,
      r.galv_on ? 1 : 0, +r.proc_manual || 0
    ));
    db.prepare("UPDATE estimates SET updated_at = datetime('now') WHERE id = ?").run(id);
  });
  tx();
  res.json(loadFullEstimate(id));
});

// Replace all process-only additional costs for an estimate.
router.put('/:id/process-addcosts', (req, res) => {
  const id = Number(req.params.id);
  const rows = Array.isArray(req.body && req.body.rows) ? req.body.rows : [];
  const ins = db.prepare(`INSERT INTO process_only_addcosts
    (estimate_id, position, name, unit, input_qty, rate, is_flat, is_labor)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM process_only_addcosts WHERE estimate_id = ?').run(id);
    rows.forEach((r, i) => ins.run(
      id, +r.position || i + 1, r.name || '', r.unit || '',
      +r.input_qty || 0, +r.rate || 0, r.is_flat ? 1 : 0, r.is_labor ? 1 : 0
    ));
    db.prepare("UPDATE estimates SET updated_at = datetime('now') WHERE id = ?").run(id);
  });
  tx();
  res.json(loadFullEstimate(id));
});

// Parse a Tekla KISS (.kss) file and return a flat list of pieces for staging.
// Does NOT save; the front end stages, the user assigns a type, then PUT process-lines.
router.post('/:id/process-import/kiss', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'file required' });
  try {
    const text = req.file.buffer.toString('utf8');
    const pieces = parseKiss(text, aiscLookup);
    res.json({ pieces, count: pieces.length });
  } catch (err) {
    res.status(400).json({ error: 'Could not parse KISS file: ' + err.message });
  }
});

// ---- INTEGRATION FEED: Won jobs for the Project Tracker (read-only) ----
// Protected by a shared secret (TRACKER_KEY), not a user login. One row per
// Won base bid that has a job number. contract_amount mirrors dashboard
// revenue (the sell price the job was won at, before sales tax).
router.get('/feed/won-jobs', (req, res) => {
  const expected = process.env.TRACKER_KEY || '';
  const provided = req.get('X-Integration-Key') || '';
  if (!expected || provided !== expected) {
    return res.status(401).json({ error: 'invalid integration key' });
  }
  const idRows = db.prepare(
    "SELECT id FROM estimates WHERE status = 'Won' AND deleted_at IS NULL AND confirmed = 1 AND is_alternate = 0 AND (bid_type = 'real' OR bid_type IS NULL) AND job_number IS NOT NULL AND job_number != ''"
  ).all();
  const jobs = [];
  for (const { id } of idRows) {
    const bundle = loadFullEstimate(id);
    if (!bundle) continue;
    jobs.push(buildWonJobPayload(bundle));
  }
  res.json({ jobs });
});

// ---- INTEGRATION FEED: Schedule of Values for one estimate (read-only) ----
// Protected by the same shared TRACKER_KEY as the won-jobs feed. Returns the
// saved SOV lines for an estimate (auto-generating from the computed totals if
// the estimate has never opened its SOV tab), in the shape the Project
// Tracker's sync-sov expects: { sov: [ { item_no, description,
// scheduled_value, position } ] }.
router.get('/feed/sov/:id', (req, res) => {
  const expected = process.env.TRACKER_KEY || '';
  const provided = req.get('X-Integration-Key') || '';
  if (!expected || provided !== expected) {
    return res.status(401).json({ error: 'invalid integration key' });
  }
  const id = Number(req.params.id);
  const est = db.prepare('SELECT id FROM estimates WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!est) return res.status(404).json({ error: 'not found' });

  let items = db.prepare(
    'SELECT item_no, description, scheduled_value, position FROM sov_items WHERE estimate_id = ? ORDER BY position, id'
  ).all(id);
  if (items.length === 0) {
    const bundle = loadFullEstimate(id);
    if (bundle) items = buildSovItems(bundle);
  }
  const sov = items.map((it, i) => ({
    item_no: it.item_no != null ? String(it.item_no) : String(i + 1),
    description: it.description || '',
    scheduled_value: +it.scheduled_value || 0,
    position: it.position != null ? it.position : i,
  }));
  res.json({ sov });
});

module.exports = { router, loadFullEstimate, estimateOwnershipCheck };
