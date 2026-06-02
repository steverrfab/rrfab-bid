'use strict';
const express = require('express');
const multer = require('multer');
const db = require('../db');
const calc = require('../lib/calc');
const { parseTemplate } = require('../lib/parser');
const { generateProposalBuffer } = require('../lib/pdf');
const { sendReadyToSubmit, sendWonNotification } = require('../lib/email');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

const aiscStmt = db.prepare('SELECT weight_per_ft FROM aisc_sections WHERE label = ?');
function aiscLookup(label) {
  if (!label) return 0;
  const row = aiscStmt.get(String(label).toUpperCase().replace(/\s+/g, ''));
  return row ? row.weight_per_ft : 0;
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

  // Material and finishes
  items.push(
    { item_no: '1', description: 'Structural Steel Material — Furnished', scheduled_value: c.materialPrice * m },
    { item_no: '2', description: 'Shop Fabrication and Finishes',         scheduled_value: (c.fabHours + c.paint + c.consumables + c.handling) * m },
    { item_no: '3', description: 'Detailing and PE-Stamped Shop Drawings', scheduled_value: (((+e.struct_detailing||0)*(+e.struct_detailing_qty||1)) + ((+e.misc_detailing||0)*(+e.misc_detailing_qty||1)) + ((+e.pe_stamp||0)*(+e.pe_stamp_qty||1))) * m },
    { item_no: '4', description: 'Freight to Jobsite',                    scheduled_value: (+e.freight || 0) * (+e.freight_qty || 1) * m },
    { item_no: '5', description: 'Field Erection, Equipment, and Rigging', scheduled_value: (c.erectionLabor + (+e.erection_equip || 0) * (+e.erection_equip_qty || 1)) * m },
    { item_no: '6', description: 'Galvanizing',                           scheduled_value: c.galv * m },
    { item_no: '7', description: 'Processing Labor',                      scheduled_value: c.processingLabor * m }
  );

  let next = 8;
  if ((+e.sub_joist_deck || 0) > 0)
    items.push({ item_no: String(next++), description: 'Joist and Deck — by Subcontractor', scheduled_value: (+e.sub_joist_deck || 0) * (+e.sub_joist_deck_qty || 1) * m });
  if ((+e.sub_erection || 0) > 0)
    items.push({ item_no: String(next++), description: 'Erection — by Subcontractor', scheduled_value: (+e.sub_erection || 0) * (+e.sub_erection_qty || 1) * m });
  (bundle.extras || []).forEach(x => {
    const amt = (+x.qty || 0) * (+x.rate || 0) * m;
    if (amt > 0) items.push({ item_no: String(next++), description: x.description || 'Additional Item', scheduled_value: amt });
  });
  return items.filter((it, i) => i === 0 || it.scheduled_value > 0).map((it, i) => ({ ...it, position: i }));
}

const EST_COLS = [
  'project_name', 'job_number', 'bid_number', 'client_gc', 'bid_date', 'proposal_date',
  'prepared_by', 'scope', 'status',
  'fab_mh', 'fab_rate', 'processing_rate',
  'paint_weight', 'paint_rate', 'consumables_weight', 'consumables_rate',
  'handling_weight', 'handling_rate', 'galv_weight', 'galv_rate',
  'struct_detailing', 'misc_detailing', 'pe_stamp', 'freight',
  'erection_mh', 'erection_rate', 'erection_equip',
  'oh_rate', 'contingency_rate', 'profit_rate', 'cgl_rate',
  'sales_tax_rate', 'tax_mode',
  'proposal_to', 'proposal_scope', 'proposal_exclusions', 'proposal_terms', 'proposal_submitted_by',
  'proposal_line_1_desc', 'proposal_line_2_desc', 'proposal_line_3_desc',
  'proposal_line_4_desc', 'proposal_line_5_desc', 'proposal_line_6_desc', 'proposal_line_7_desc',
  'ljb_tons', 'ljb_distance_miles', 'ljb_galv_lbs', 'ljb_aess_lbs',
  'ljb_aess_rate', 'ljb_galv_rate', 'ljb_joist_sub1', 'ljb_joist_sub2',
  'ljb_erect_sub1', 'ljb_erect_sub2', 'ljb_op_rate', 'ljb_shop_dwg_pages',
  'submitted_at',
  'notes',
  'sub_joist_deck', 'sub_erection',
  'struct_detailing_qty', 'misc_detailing_qty', 'pe_stamp_qty',
  'freight_qty', 'erection_equip_qty', 'sub_joist_deck_qty', 'sub_erection_qty'
];

function loadFullEstimate(id) {
  const est = db.prepare('SELECT * FROM estimates WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!est) return null;
  const overrides = db.prepare('SELECT section, weight_lb, cost_per_cwt, source FROM material_overrides WHERE estimate_id = ?').all(id);
  const shapes = db.prepare('SELECT * FROM takeoff_shapes WHERE estimate_id = ? ORDER BY section_type, position').all(id);
  const plates = db.prepare('SELECT * FROM takeoff_plates WHERE estimate_id = ? ORDER BY position').all(id);
  const misc = db.prepare('SELECT * FROM takeoff_misc WHERE estimate_id = ? ORDER BY position').all(id);
  const wages = db.prepare('SELECT * FROM wage_rates WHERE estimate_id = ?').all(id);
  const extras = db.prepare('SELECT * FROM estimate_extras WHERE estimate_id = ? ORDER BY section, position').all(id);
  const computed = calc.compute(est, overrides, shapes, plates, misc, aiscLookup, extras);
  const standardExclusions = db.prepare('SELECT * FROM standard_exclusions ORDER BY position, id').all();
  const siteExclusions = db.prepare('SELECT * FROM estimate_site_exclusions WHERE estimate_id = ? ORDER BY position, id').all(id);
  return { estimate: est, overrides, shapes, plates, misc, wages, extras, computed, standardExclusions, siteExclusions };
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
  const est = db.prepare('SELECT created_by FROM estimates WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!est) return next(); // let the route return 404
  if (est.created_by !== null && est.created_by !== req.user.userId) {
    return res.status(403).json({ error: 'Access denied.' });
  }
  next();
}

router.param('id', (req, res, next, id) => {
  estimateOwnershipCheck(req, res, next);
});

// ---- LIST ----
router.get('/', (req, res) => {
  if (isAdminish(req.user.role)) {
    const rows = db.prepare(`
      SELECT e.id, e.project_name, e.job_number, e.bid_number, e.client_gc, e.bid_date,
             e.status, e.updated_at, e.created_at, e.submitted_at, e.created_by, e.due_date,
             u.name as owner_name, u.email as owner_email
      FROM estimates e
      LEFT JOIN users u ON u.id = e.created_by
      WHERE e.deleted_at IS NULL
      ORDER BY e.updated_at DESC
    `).all();
    return res.json({ rows });
  }
  // Estimators: only see their own + legacy estimates with no owner
  const rows = db.prepare(`
    SELECT e.id, e.project_name, e.job_number, e.bid_number, e.client_gc, e.bid_date,
           e.status, e.updated_at, e.created_at, e.submitted_at, e.created_by, e.due_date,
           u.name as owner_name, u.email as owner_email
    FROM estimates e
    LEFT JOIN users u ON u.id = e.created_by
    WHERE (e.created_by = ? OR e.created_by IS NULL) AND e.deleted_at IS NULL
    ORDER BY e.updated_at DESC
  `).all(req.user.userId);
  res.json({ rows });
});

// ---- DASHBOARD SUMMARY ----
// Per-estimate financials + key dates for the dashboard cards.
// revenue = total bid (sell price, before tax); profit = bid minus direct job cost.
// Respects the same role visibility as the list endpoint.
router.get('/summary', (req, res) => {
  const idRows = isAdminish(req.user.role)
    ? db.prepare('SELECT id FROM estimates WHERE deleted_at IS NULL').all()
    : db.prepare('SELECT id FROM estimates WHERE (created_by = ? OR created_by IS NULL) AND deleted_at IS NULL').all(req.user.userId);

  const rows = [];
  for (const { id } of idRows) {
    const bundle = loadFullEstimate(id);
    if (!bundle) continue;
    const e = bundle.estimate;
    const c = bundle.computed || {};
    const revenue = +c.totalBid || 0;
    const profit = revenue - (+c.directCost || 0);
    rows.push({
      id: e.id,
      project_name: e.project_name || '',
      bid_number: e.bid_number || '',
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

// ---- CREATE ----
router.post('/', (req, res) => {
  const stmt = db.prepare(`INSERT INTO estimates
    (processing_rate, fab_rate, paint_rate, consumables_rate, handling_rate, galv_rate, created_by)
    VALUES (0, 85, 0.08, 0.03, 0.05, 1.00, ?)`);
  const info = stmt.run(req.user.userId);
  const id = info.lastInsertRowid;
  if (req.body && Object.keys(req.body).length) {
    applyUpdate(id, req.body);
  }
  const bundle = loadFullEstimate(id);
  res.status(201).json(bundle);
});

// ---- GET ----
router.get('/:id', (req, res) => {
  const bundle = loadFullEstimate(Number(req.params.id));
  if (!bundle) return res.status(404).json({ error: 'not found' });
  res.json(bundle);
});

// ---- UPDATE ----
router.put('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const prev = db.prepare('SELECT id, status FROM estimates WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!prev) return res.status(404).json({ error: 'not found' });
  applyUpdate(id, req.body || {});
  const bundle = loadFullEstimate(id);

  // On transition to Won: auto-generate SOV if not already present, then email recipients
  const newStatus = (req.body || {}).status;
  if (newStatus === 'Won' && prev.status !== 'Won') {
    // Stamp the date this bid was marked Won (drives the dashboard Won card time filter)
    db.prepare("UPDATE estimates SET won_at = datetime('now') WHERE id = ?").run(id);
    const existingSov = db.prepare('SELECT id FROM sov_items WHERE estimate_id = ? LIMIT 1').get(id);
    if (!existingSov) {
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
    sendWonNotification(bundle, recipients).catch(err => console.error('[sov] email error:', err));
  }

  res.json(bundle);
});

function applyUpdate(id, body) {
  const sets = [];
  const vals = [];
  for (const k of EST_COLS) {
    if (Object.prototype.hasOwnProperty.call(body, k)) {
      sets.push(`${k} = ?`);
      vals.push(body[k]);
    }
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
  res.json({ deleted: id });
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
        submitted_at = ?,
        proposal_date = ?,
        updated_at = datetime('now')
    WHERE id = ?
  `).run(now, proposalDate, id);

  const bundle = loadFullEstimate(id);
  const recipients = db.prepare('SELECT email, name FROM notification_recipients WHERE active = 1').all();

  // Send email notification (fire-and-forget)
  sendReadyToSubmit(bundle, recipients).catch(err => console.error('[submit] email error:', err));

  // Return bundle with notification info (send doesn't wait for email)
  res.json({
    ...bundle,
    notification: { ok: true, sent: recipients.length }
  });
});

// ---- CLONE ----
router.post('/:id/clone', (req, res) => {
  const id = Number(req.params.id);
  const src = db.prepare('SELECT * FROM estimates WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!src) return res.status(404).json({ error: 'not found' });

  const cols = EST_COLS.filter(c => c !== 'submitted_at');
  const suffix = src.status === 'Submitted' ? ' (rev)' : ' (copy)';
  const placeholders = cols.map(() => '?').join(',');
  const vals = cols.map(c => c === 'status' ? 'Draft' : (c === 'project_name' ? (src[c] || '') + suffix : src[c]));
  const result = db.prepare(`INSERT INTO estimates (${cols.join(',')}) VALUES (${placeholders})`).run(...vals);
  const newId = result.lastInsertRowid;

  db.prepare(`
    INSERT INTO material_overrides (estimate_id, section, weight_lb, cost_per_cwt)
    SELECT ?, section, weight_lb, cost_per_cwt FROM material_overrides WHERE estimate_id = ?
  `).run(newId, id);
  db.prepare(`
    INSERT INTO takeoff_shapes (estimate_id, section_type, position, section_name, cost_factor, drop_ft, l1,l2,l3,l4,l5,l6,l7,l8, notes)
    SELECT ?, section_type, position, section_name, cost_factor, drop_ft, l1,l2,l3,l4,l5,l6,l7,l8, notes FROM takeoff_shapes WHERE estimate_id = ?
  `).run(newId, id);
  db.prepare(`
    INSERT INTO takeoff_plates (estimate_id, position, thickness, cost_factor, width_in, length_in, qty, notes)
    SELECT ?, position, thickness, cost_factor, width_in, length_in, qty, notes FROM takeoff_plates WHERE estimate_id = ?
  `).run(newId, id);
  db.prepare(`
    INSERT INTO takeoff_misc (estimate_id, position, description, qty, weight_each_lb, cost_per_cwt, notes)
    SELECT ?, position, description, qty, weight_each_lb, cost_per_cwt, notes FROM takeoff_misc WHERE estimate_id = ?
  `).run(newId, id);
  db.prepare(`
    INSERT INTO wage_rates (estimate_id, role, base_rate, cash_in_lieu, fica_pct, futa_pct, suta_pct, wc_pct, gl_pct, umbrella_pct, auto_pct, pp_bond_pct, health_welfare, pension, consumables_pct, fuel_pct, ohp_pct)
    SELECT ?, role, base_rate, cash_in_lieu, fica_pct, futa_pct, suta_pct, wc_pct, gl_pct, umbrella_pct, auto_pct, pp_bond_pct, health_welfare, pension, consumables_pct, fuel_pct, ohp_pct FROM wage_rates WHERE estimate_id = ?
  `).run(newId, id);

  res.status(201).json(loadFullEstimate(newId));
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
        l1,l2,l3,l4,l5,l6,l7,l8, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        r.notes || ''
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
      INSERT INTO takeoff_misc (estimate_id, position, description, qty, weight_each_lb, cost_per_cwt, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?)
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
        r.notes || ''
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
    const parsed = await parseTemplate(req.file.buffer);
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
        INSERT INTO takeoff_shapes (estimate_id, position, section_type, section_name, cost_factor, drop_ft, l1, l2, l3, l4, l5, l6, l7, l8, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      (parsed.shapes || []).forEach((r, i) => {
        shapeInsert.run(
          id, startShapePos + i + 1,
          r.section_type || '', r.section_name || '',
          +r.cost_factor || 0, +r.drop_ft || 0,
          +r.l1 || 0, +r.l2 || 0, +r.l3 || 0, +r.l4 || 0,
          +r.l5 || 0, +r.l6 || 0, +r.l7 || 0, +r.l8 || 0,
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

    // Auto-populate weight fields and drawing scope
    let bundle = loadFullEstimate(id);
    const totalWeight = bundle.computed.materialWeight || 0;
    if (totalWeight > 0 || drawingNumbers) {
      const scopeText = drawingNumbers ? 'Drawing(s): ' + drawingNumbers : '';
      db.prepare(`
        UPDATE estimates
        SET paint_weight = ?, galv_weight = ?, consumables_weight = ?, handling_weight = ?, scope = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(totalWeight, totalWeight, totalWeight, totalWeight, scopeText, id);
    }

    bundle = loadFullEstimate(id);
    res.json({ ...bundle, parsed: {
      shapes: (parsed.shapes || []).length,
      plates: (parsed.plates || []).length,
      misc:   (parsed.misc || []).length,
    }});
  } catch (err) {
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

module.exports = { router, loadFullEstimate, estimateOwnershipCheck };
