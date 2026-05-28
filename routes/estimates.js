'use strict';
const express = require('express');
const multer = require('multer');
const db = require('../db');
const calc = require('../lib/calc');
const { parseTemplate } = require('../lib/parser');
const { generateProposalBuffer } = require('../lib/pdf');
const { sendReadyToSubmit } = require('../lib/email');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

const aiscStmt = db.prepare('SELECT weight_per_ft FROM aisc_sections WHERE label = ?');
function aiscLookup(label) {
  if (!label) return 0;
  const row = aiscStmt.get(String(label).toUpperCase().replace(/\s+/g, ''));
  return row ? row.weight_per_ft : 0;
}

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
  'proposal_line_1_desc', 'proposal_line_2_desc', 'proposal_line_3_desc',
  'proposal_line_4_desc', 'proposal_line_5_desc', 'proposal_line_6_desc', 'proposal_line_7_desc',
  'ljb_tons', 'ljb_distance_miles', 'ljb_galv_lbs', 'ljb_aess_lbs',
  'ljb_aess_rate', 'ljb_galv_rate', 'ljb_joist_sub1', 'ljb_joist_sub2',
  'ljb_erect_sub1', 'ljb_erect_sub2', 'ljb_op_rate', 'ljb_shop_dwg_pages',
  'submitted_at',
  'notes'
];

function loadFullEstimate(id) {
  const est = db.prepare('SELECT * FROM estimates WHERE id = ?').get(id);
  if (!est) return null;
  const overrides = db.prepare('SELECT section, weight_lb, cost_per_cwt FROM material_overrides WHERE estimate_id = ?').all(id);
  const shapes = db.prepare('SELECT * FROM takeoff_shapes WHERE estimate_id = ? ORDER BY section_type, position').all(id);
  const plates = db.prepare('SELECT * FROM takeoff_plates WHERE estimate_id = ? ORDER BY position').all(id);
  const misc = db.prepare('SELECT * FROM takeoff_misc WHERE estimate_id = ? ORDER BY position').all(id);
  const wages = db.prepare('SELECT * FROM wage_rates WHERE estimate_id = ?').all(id);
  const computed = calc.compute(est, overrides, shapes, plates, misc, aiscLookup);
  return { estimate: est, overrides, shapes, plates, misc, wages, computed };
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
  const { weight_lb, cost_per_cwt } = req.body || {};
  if ((weight_lb == null || weight_lb === '' || +weight_lb <= 0)
      && (cost_per_cwt == null || cost_per_cwt === '' || +cost_per_cwt <= 0)) {
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
    parsed.shapes = parsed.shapes.map(r => ({ ...r, cost_factor: r.cost_factor || pb[r.section_type] || 0 }));
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

      const insertMisc = db.prepare(`
        INSERT INTO takeoff_misc (estimate_id, position, description, qty, weight_each_lb, cost_per_cwt, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      (parsed.misc || []).forEach((r, i) => insertMisc.run(
        id, startMiscPos + i + 1, r.description, r.qty, r.weight_each_lb, r.cost_per_cwt, r.notes
      ));

      db.prepare("UPDATE estimates SET updated_at = datetime('now') WHERE id = ?").run(id);
    });
    tx();

    const bundle = loadFullEstimate(id);
    res.json({
      ...bundle,
      parsed: {
        shapes: parsed.shapes.length,
        plates: parsed.plates.length,
        misc: (parsed.misc || []).length,
        errors: parsed.errors
      }
    });
  } catch (err) {
    console.error('upload error:', err);
    res.status(500).json({ error: err.message || 'parse failed' });
  }
});

// ---- READY TO SUBMIT ----
router.post('/:id/submit', async (req, res) => {
  const id = Number(req.params.id);
  const exists = db.prepare('SELECT id FROM estimates WHERE id = ?').get(id);
  if (!exists) return res.status(404).json({ error: 'not found' });

  db.prepare("UPDATE estimates SET status = 'Submitted', submitted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(id);
  const bundle = loadFullEstimate(id);

  const recipients = db.prepare(`
    SELECT email, name FROM notification_recipients WHERE active = 1 ORDER BY created_at ASC
  `).all();

  let pdfBuffer = null;
  try {
    pdfBuffer = await generateProposalBuffer(bundle);
  } catch (err) {
    console.error('[submit] PDF generation failed:', err);
  }

  const emailResult = await sendReadyToSubmit(bundle, recipients, pdfBuffer);

  res.json({ ...bundle, notification: emailResult });
});

module.exports = router;
