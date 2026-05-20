'use strict';
const express = require('express');
const multer = require('multer');
const db = require('../db');
const calc = require('../lib/calc');
const { parseTemplate } = require('../lib/parser');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

// AISC lookup helper for the calc engine
const aiscStmt = db.prepare('SELECT weight_per_ft FROM aisc_sections WHERE label = ?');
function aiscLookup(label) {
  if (!label) return 0;
  const row = aiscStmt.get(String(label).toUpperCase().replace(/\s+/g, ''));
  return row ? row.weight_per_ft : 0;
}

// All columns on estimates (kept central so insert/update stay in sync)
const EST_COLS = [
  'project_name', 'job_number', 'bid_number', 'client_gc', 'bid_date',
  'prepared_by', 'scope', 'status',
  'fab_mh', 'fab_rate', 'processing_rate',
  'paint_weight', 'paint_rate', 'consumables_weight', 'consumables_rate',
  'handling_weight', 'handling_rate', 'galv_weight', 'galv_rate',
  'struct_detailing', 'misc_detailing', 'pe_stamp', 'freight',
  'erection_mh', 'erection_rate', 'erection_equip',
  'oh_rate', 'contingency_rate', 'profit_rate', 'cgl_rate',
  'sales_tax_rate', 'tax_mode',
  'proposal_to', 'proposal_scope', 'proposal_exclusions', 'proposal_terms', 'proposal_submitted_by',
  'ljb_tons', 'ljb_distance_miles', 'ljb_galv_lbs', 'ljb_aess_lbs',
  'ljb_aess_rate', 'ljb_galv_rate', 'ljb_joist_sub1', 'ljb_joist_sub2',
  'ljb_erect_sub1', 'ljb_erect_sub2', 'ljb_op_rate', 'ljb_shop_dwg_pages',
  'submitted_at'
];

function loadFullEstimate(id) {
  const est = db.prepare('SELECT * FROM estimates WHERE id = ?').get(id);
  if (!est) return null;
  const overrides = db.prepare('SELECT section, weight_lb, cost_per_cwt FROM material_overrides WHERE estimate_id = ?').all(id);
  const shapes = db.prepare('SELECT * FROM takeoff_shapes WHERE estimate_id = ? ORDER BY section_type, position').all(id);
  const plates = db.prepare('SELECT * FROM takeoff_plates WHERE estimate_id = ? ORDER BY position').all(id);
  const wages = db.prepare('SELECT * FROM wage_rates WHERE estimate_id = ?').all(id);
  const computed = calc.compute(est, overrides, shapes, plates, aiscLookup);
  return { estimate: est, overrides, shapes, plates, wages, computed };
}

// ---- LIST ----
router.get('/', (req, res) => {
  const rows = db.prepare(`
    SELECT id, project_name, job_number, bid_number, client_gc, bid_date,
           status, updated_at, created_at, submitted_at
    FROM estimates
    ORDER BY updated_at DESC
  `).all();
  res.json({ rows });
});

// ---- CREATE ----
router.post('/', (req, res) => {
  const stmt = db.prepare('INSERT INTO estimates DEFAULT VALUES');
  const info = stmt.run();
  const id = info.lastInsertRowid;
  // If body has fields, apply them
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
router.put('/:id', (req, res) => {
  const id = Number(req.params.id);
  const exists = db.prepare('SELECT id FROM estimates WHERE id = ?').get(id);
  if (!exists) return res.status(404).json({ error: 'not found' });
  applyUpdate(id, req.body || {});
  res.json(loadFullEstimate(id));
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
  const info = db.prepare('DELETE FROM estimates WHERE id = ?').run(id);
  if (info.changes === 0) return res.status(404).json({ error: 'not found' });
  res.json({ deleted: id });
});

// ---- CLONE ----
router.post('/:id/clone', (req, res) => {
  const id = Number(req.params.id);
  const src = db.prepare('SELECT * FROM estimates WHERE id = ?').get(id);
  if (!src) return res.status(404).json({ error: 'not found' });

  const cols = EST_COLS.filter(c => c !== 'submitted_at');
  const placeholders = cols.map(() => '?').join(',');
  const vals = cols.map(c => c === 'status' ? 'Draft' : (c === 'project_name' ? (src[c] || '') + ' (copy)' : src[c]));
  const result = db.prepare(`INSERT INTO estimates (${cols.join(',')}) VALUES (${placeholders})`).run(...vals);
  const newId = result.lastInsertRowid;

  // Copy related rows
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
    INSERT INTO wage_rates (estimate_id, role, base_rate, cash_in_lieu, fica_pct, futa_pct, suta_pct, wc_pct, gl_pct, umbrella_pct, auto_pct, pp_bond_pct, health_welfare, pension, consumables_pct, fuel_pct, ohp_pct)
    SELECT ?, role, base_rate, cash_in_lieu, fica_pct, futa_pct, suta_pct, wc_pct, gl_pct, umbrella_pct, auto_pct, pp_bond_pct, health_welfare, pension, consumables_pct, fuel_pct, ohp_pct FROM wage_rates WHERE estimate_id = ?
  `).run(newId, id);

  res.status(201).json(loadFullEstimate(newId));
});

// ---- MATERIAL OVERRIDES ----
router.put('/:id/material/:section', (req, res) => {
  const id = Number(req.params.id);
  const section = String(req.params.section).toUpperCase();
  const { weight_lb, cost_per_cwt } = req.body || {};
  if ((weight_lb == null || weight_lb === '' || +weight_lb <= 0)
      && (cost_per_cwt == null || cost_per_cwt === '' || +cost_per_cwt <= 0)) {
    // Empty -> remove the override
    db.prepare('DELETE FROM material_overrides WHERE estimate_id = ? AND section = ?').run(id, section);
  } else {
    db.prepare(`
      INSERT INTO material_overrides (estimate_id, section, weight_lb, cost_per_cwt)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(estimate_id, section) DO UPDATE SET
        weight_lb = excluded.weight_lb,
        cost_per_cwt = excluded.cost_per_cwt
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
  res.json(loadFullEstimate(id));
});

// ---- UPLOAD TAKEOFF FILE (.xlsx template) ----
router.post('/:id/takeoff/upload', upload.single('file'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!req.file) return res.status(400).json({ error: 'file required' });
    const parsed = await parseTemplate(req.file.buffer);
    const mode = String(req.body.mode || 'replace'); // replace | append

    const tx = db.transaction(() => {
      if (mode === 'replace') {
        db.prepare('DELETE FROM takeoff_shapes WHERE estimate_id = ?').run(id);
        db.prepare('DELETE FROM takeoff_plates WHERE estimate_id = ?').run(id);
      }
      const startShapePos = mode === 'append'
        ? (db.prepare('SELECT MAX(position) as p FROM takeoff_shapes WHERE estimate_id = ?').get(id).p || 0)
        : 0;
      const startPlatePos = mode === 'append'
        ? (db.prepare('SELECT MAX(position) as p FROM takeoff_plates WHERE estimate_id = ?').get(id).p || 0)
        : 0;

      const insertShape = db.prepare(`
        INSERT INTO takeoff_shapes (estimate_id, section_type, position, section_name, cost_factor, drop_ft,
          l1,l2,l3,l4,l5,l6,l7,l8, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      parsed.shapes.forEach((r, i) => insertShape.run(
        id, r.section_type, startShapePos + i + 1, r.section_name, r.cost_factor, r.drop_ft,
        r.l1, r.l2, r.l3, r.l4, r.l5, r.l6, r.l7, r.l8, r.notes
      ));

      const insertPlate = db.prepare(`
        INSERT INTO takeoff_plates (estimate_id, position, thickness, cost_factor, width_in, length_in, qty, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      parsed.plates.forEach((r, i) => insertPlate.run(
        id, startPlatePos + i + 1, r.thickness, r.cost_factor, r.width_in, r.length_in, r.qty, r.notes
      ));

      db.prepare("UPDATE estimates SET updated_at = datetime('now') WHERE id = ?").run(id);
    });
    tx();

    const bundle = loadFullEstimate(id);
    res.json({ ...bundle, parsed: { shapes: parsed.shapes.length, plates: parsed.plates.length, errors: parsed.errors } });
  } catch (err) {
    console.error('upload error:', err);
    res.status(500).json({ error: err.message || 'parse failed' });
  }
});

// ---- SUBMIT BID ----
router.post('/:id/submit', (req, res) => {
  const id = Number(req.params.id);
  const exists = db.prepare('SELECT id FROM estimates WHERE id = ?').get(id);
  if (!exists) return res.status(404).json({ error: 'not found' });
  db.prepare("UPDATE estimates SET status = 'Submitted', submitted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(id);
  res.json(loadFullEstimate(id));
});

module.exports = router;
