'use strict';
const express = require('express');
const router = express.Router({ mergeParams: true });
const db = require('../db');
const { loadFullEstimate } = require('./estimates');

function getEstimate(id) {
  return db.prepare('SELECT id FROM estimates WHERE id = ? AND deleted_at IS NULL').get(id);
}

// POST /api/estimates/:id/extras
// Body: { section, description, unit, qty, rate, weight_lb, notes }
router.post('/', (req, res) => {
  const estimateId = Number(req.params.id);
  if (!getEstimate(estimateId)) return res.status(404).json({ error: 'estimate not found' });

  const { section, description = '', unit = 'LS', qty = 1, rate = 0, weight_lb = 0, notes = '' } = req.body || {};
  const sec = Number(section);
  if (![1, 2, 3, 4].includes(sec)) return res.status(400).json({ error: 'section must be 1, 2, 3, or 4' });

  const maxRow = db.prepare('SELECT MAX(position) as m FROM estimate_extras WHERE estimate_id = ? AND section = ?').get(estimateId, sec);
  const position = (maxRow.m || 0) + 1;

  db.prepare(
    'INSERT INTO estimate_extras (estimate_id, section, position, description, unit, qty, rate, weight_lb, notes) VALUES (?,?,?,?,?,?,?,?,?)'
  ).run(estimateId, sec, position, String(description), String(unit), +qty || 1, +rate || 0, +weight_lb || 0, String(notes));

  res.status(201).json(loadFullEstimate(estimateId));
});

// PUT /api/estimates/:id/extras/:extraId
// Body: any subset of { description, unit, qty, rate, weight_lb, notes }
router.put('/:extraId', (req, res) => {
  const estimateId = Number(req.params.id);
  const extraId = Number(req.params.extraId);

  const row = db.prepare('SELECT * FROM estimate_extras WHERE id = ? AND estimate_id = ?').get(extraId, estimateId);
  if (!row) return res.status(404).json({ error: 'extra row not found' });

  const { description, unit, qty, rate, weight_lb, notes } = req.body || {};
  db.prepare(`UPDATE estimate_extras SET
    description = COALESCE(?, description),
    unit        = COALESCE(?, unit),
    qty         = COALESCE(?, qty),
    rate        = COALESCE(?, rate),
    weight_lb   = COALESCE(?, weight_lb),
    notes       = COALESCE(?, notes)
    WHERE id = ? AND estimate_id = ?`
  ).run(
    description != null ? String(description) : null,
    unit        != null ? String(unit)        : null,
    qty         != null ? +qty                : null,
    rate        != null ? +rate               : null,
    weight_lb   != null ? +weight_lb          : null,
    notes       != null ? String(notes)       : null,
    extraId, estimateId
  );

  res.json(loadFullEstimate(estimateId));
});

// DELETE /api/estimates/:id/extras/:extraId
router.delete('/:extraId', (req, res) => {
  const estimateId = Number(req.params.id);
  const extraId = Number(req.params.extraId);

  const row = db.prepare('SELECT id FROM estimate_extras WHERE id = ? AND estimate_id = ?').get(extraId, estimateId);
  if (!row) return res.status(404).json({ error: 'extra row not found' });

  db.prepare('DELETE FROM estimate_extras WHERE id = ? AND estimate_id = ?').run(extraId, estimateId);
  res.json(loadFullEstimate(estimateId));
});

module.exports = router;
