'use strict';
const express = require('express');
const router = express.Router({ mergeParams: true });
const db = require('../db');
const { requireAuth } = require('../lib/auth');
const { loadFullEstimate } = require('./estimates');
const { generateSov } = require('../lib/sov_pdf');

router.use(requireAuth);

// Build auto-generated SOV line items from computed totals.
// Mirrors the proposal line items structure.
function autoGenerateItems(bundle) {
  const e = bundle.estimate;
  const c = bundle.computed;

  function mf() {
    return (1 + (+e.oh_rate || 0))
         * (1 + (+e.contingency_rate || 0))
         * (1 + (+e.profit_rate || 0))
         * (1 + (+e.cgl_rate || 0));
  }
  const m = mf();

  const items = [
    { item_no: '1', description: 'Structural Steel Material — Furnished', scheduled_value: c.materialPrice * m },
    { item_no: '2', description: 'Shop Fabrication and Finishes',         scheduled_value: (c.fabHours + c.paint + c.consumables + c.handling) * m },
    { item_no: '3', description: 'Detailing and PE-Stamped Shop Drawings', scheduled_value: ((+e.struct_detailing || 0) + (+e.misc_detailing || 0) + (+e.pe_stamp || 0)) * m },
    { item_no: '4', description: 'Freight to Jobsite',                    scheduled_value: (+e.freight || 0) * m },
    { item_no: '5', description: 'Field Erection, Equipment, and Rigging', scheduled_value: (c.erectionLabor + (+e.erection_equip || 0)) * m },
    { item_no: '6', description: 'Galvanizing',                           scheduled_value: c.galv * m },
    { item_no: '7', description: 'Processing Labor',                      scheduled_value: c.processingLabor * m }
  ];

  // Add sub items if non-zero
  let next = 8;
  if ((+e.sub_joist_deck || 0) > 0) {
    items.push({ item_no: String(next++), description: 'Joist and Deck — by Subcontractor', scheduled_value: (+e.sub_joist_deck || 0) * m });
  }
  if ((+e.sub_erection || 0) > 0) {
    items.push({ item_no: String(next++), description: 'Erection — by Subcontractor', scheduled_value: (+e.sub_erection || 0) * m });
  }

  // Add any estimate extras
  const extras = bundle.extras || [];
  extras.forEach(x => {
    const amt = (+x.qty || 0) * (+x.rate || 0) * m;
    if (amt > 0) {
      items.push({ item_no: String(next++), description: x.description || 'Additional Item', scheduled_value: amt });
    }
  });

  // Filter out zero-value items (except item 1 which should always show)
  return items.filter((it, i) => i === 0 || it.scheduled_value > 0)
    .map((it, i) => ({ ...it, position: i }));
}

// GET /api/estimates/:id/sov — list items, auto-generate if none exist yet
router.get('/', (req, res) => {
  const id = Number(req.params.id);
  const est = db.prepare('SELECT id FROM estimates WHERE id = ?').get(id);
  if (!est) return res.status(404).json({ error: 'not found' });

  let items = db.prepare('SELECT * FROM sov_items WHERE estimate_id = ? ORDER BY position, id').all(id);
  if (items.length === 0) {
    const bundle = loadFullEstimate(id);
    if (!bundle) return res.status(404).json({ error: 'not found' });
    const auto = autoGenerateItems(bundle);
    const insert = db.prepare(
      'INSERT INTO sov_items (estimate_id, item_no, description, scheduled_value, position) VALUES (?,?,?,?,?)'
    );
    const tx = db.transaction(arr => {
      for (const it of arr) insert.run(id, it.item_no, it.description, it.scheduled_value, it.position);
    });
    tx(auto);
    items = db.prepare('SELECT * FROM sov_items WHERE estimate_id = ? ORDER BY position, id').all(id);
  }
  res.json(items);
});

// PUT /api/estimates/:id/sov — replace all items
router.put('/', (req, res) => {
  const id = Number(req.params.id);
  const est = db.prepare('SELECT id FROM estimates WHERE id = ?').get(id);
  if (!est) return res.status(404).json({ error: 'not found' });

  const items = Array.isArray(req.body) ? req.body : [];
  const del = db.prepare('DELETE FROM sov_items WHERE estimate_id = ?');
  const ins = db.prepare(
    'INSERT INTO sov_items (estimate_id, item_no, description, scheduled_value, position) VALUES (?,?,?,?,?)'
  );
  const tx = db.transaction(arr => {
    del.run(id);
    arr.forEach((it, i) => ins.run(id, it.item_no || String(i + 1), it.description || '', +it.scheduled_value || 0, i));
  });
  tx(items);
  res.json(db.prepare('SELECT * FROM sov_items WHERE estimate_id = ? ORDER BY position, id').all(id));
});

// POST /api/estimates/:id/sov/regenerate — discard and rebuild from current computed totals
router.post('/regenerate', (req, res) => {
  const id = Number(req.params.id);
  const bundle = loadFullEstimate(id);
  if (!bundle) return res.status(404).json({ error: 'not found' });

  const auto = autoGenerateItems(bundle);
  const del = db.prepare('DELETE FROM sov_items WHERE estimate_id = ?');
  const ins = db.prepare(
    'INSERT INTO sov_items (estimate_id, item_no, description, scheduled_value, position) VALUES (?,?,?,?,?)'
  );
  const tx = db.transaction(arr => {
    del.run(id);
    for (const it of arr) ins.run(id, it.item_no, it.description, it.scheduled_value, it.position);
  });
  tx(auto);
  res.json(db.prepare('SELECT * FROM sov_items WHERE estimate_id = ? ORDER BY position, id').all(id));
});

// GET /api/estimates/:id/sov/pdf — download SOV PDF
router.get('/pdf', (req, res) => {
  const id = Number(req.params.id);
  const bundle = loadFullEstimate(id);
  if (!bundle) return res.status(404).json({ error: 'not found' });

  let items = db.prepare('SELECT * FROM sov_items WHERE estimate_id = ? ORDER BY position, id').all(id);
  if (items.length === 0) {
    items = autoGenerateItems(bundle).map((it, i) => ({ ...it, id: i, estimate_id: id }));
  }
  bundle.sovItems = items;
  generateSov(res, bundle);
});

module.exports = router;
