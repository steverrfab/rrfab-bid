'use strict';
const express = require('express');
const db = require('../db');
const calc = require('../lib/calc');
const { generateProposal } = require('../lib/pdf');

const router = express.Router({ mergeParams: true });

const aiscStmt = db.prepare('SELECT weight_per_ft FROM aisc_sections WHERE label = ?');
function aiscLookup(label) {
  if (!label) return 0;
  const row = aiscStmt.get(String(label).toUpperCase().replace(/\s+/g, ''));
  return row ? row.weight_per_ft : 0;
}

router.get('/', (req, res) => {
  const id = Number(req.params.id);
  const est = db.prepare('SELECT * FROM estimates WHERE id = ?').get(id);
  if (!est) return res.status(404).json({ error: 'not found' });
  const overrides = db.prepare('SELECT section, weight_lb, cost_per_cwt FROM material_overrides WHERE estimate_id = ?').all(id);
  const shapes = db.prepare('SELECT * FROM takeoff_shapes WHERE estimate_id = ?').all(id);
  const plates = db.prepare('SELECT * FROM takeoff_plates WHERE estimate_id = ?').all(id);
  const misc = db.prepare('SELECT * FROM takeoff_misc WHERE estimate_id = ?').all(id);
  const computed = calc.compute(est, overrides, shapes, plates, misc, aiscLookup);
  generateProposal(res, { estimate: est, computed });
});

module.exports = router;
