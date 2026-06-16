'use strict';
// Client-proposal line edits: manually added lines and per-line hide state.
// Mounted at /api/estimates/:id/proposal-lines (ownership-checked in server.js).
// Each handler returns the full reloaded estimate bundle, matching the extras
// route pattern, so the frontend always gets fresh computed totals back.
const express = require('express');
const router = express.Router({ mergeParams: true });
const db = require('../db');
const { loadFullEstimate } = require('./estimates');

function getEstimate(id) {
  return db.prepare('SELECT id FROM estimates WHERE id = ? AND deleted_at IS NULL').get(id);
}

// keep_in_total is tri-state: 1 (kept), 0 (excluded), or null (undecided).
// Only 0/1/null are accepted; anything else becomes null.
function normKeep(v) {
  if (v === 1 || v === true || v === '1') return 1;
  if (v === 0 || v === false || v === '0') return 0;
  return null;
}

// POST / — add a manual line. Body: { description, amount }
router.post('/', (req, res) => {
  const id = Number(req.params.id);
  if (!getEstimate(id)) return res.status(404).json({ error: 'estimate not found' });
  const { description = '', amount = 0, cost = 0 } = req.body || {};
  const maxRow = db.prepare('SELECT MAX(position) AS m FROM proposal_manual_lines WHERE estimate_id = ?').get(id);
  const position = (maxRow.m || 0) + 1;
  db.prepare(
    'INSERT INTO proposal_manual_lines (estimate_id, position, description, amount, cost, hidden, keep_in_total) VALUES (?,?,?,?,?,0,NULL)'
  ).run(id, position, String(description), +amount || 0, +cost || 0);
  res.status(201).json(loadFullEstimate(id));
});

// PUT /visibility — upsert hide state for a built-in/extra line.
// Body: { line_key, hidden, keep_in_total }. Defined before /:lineId so the
// literal path is not captured by the numeric param route.
router.put('/visibility', (req, res) => {
  const id = Number(req.params.id);
  if (!getEstimate(id)) return res.status(404).json({ error: 'estimate not found' });
  const { line_key } = req.body || {};
  if (!line_key || typeof line_key !== 'string') return res.status(400).json({ error: 'line_key required' });
  const hidden = req.body.hidden ? 1 : 0;
  const keep = normKeep(req.body.keep_in_total);
  db.prepare(
    `INSERT INTO proposal_line_visibility (estimate_id, line_key, hidden, keep_in_total)
     VALUES (?,?,?,?)
     ON CONFLICT(estimate_id, line_key)
     DO UPDATE SET hidden = excluded.hidden, keep_in_total = excluded.keep_in_total`
  ).run(id, line_key, hidden, keep);
  res.json(loadFullEstimate(id));
});

// PUT /client — upsert the client-facing override for one line (its description
// and/or shown amount). This is where the price-to-win discount lands per line.
// Presentation only: never affects cost, margin, or the dashboard. Defined
// before /:lineId so the literal path is not captured by the numeric param route.
router.put('/client', (req, res) => {
  const id = Number(req.params.id);
  if (!getEstimate(id)) return res.status(404).json({ error: 'estimate not found' });
  const { line_key } = req.body || {};
  if (!line_key || typeof line_key !== 'string') return res.status(400).json({ error: 'line_key required' });
  const desc = req.body.description != null ? String(req.body.description) : null;
  const amount = req.body.amount != null ? (+req.body.amount || 0) : null;
  db.prepare(
    `INSERT INTO proposal_client_lines (estimate_id, line_key, description, amount)
     VALUES (?,?,?,?)
     ON CONFLICT(estimate_id, line_key)
     DO UPDATE SET description = COALESCE(excluded.description, proposal_client_lines.description),
                   amount      = COALESCE(excluded.amount, proposal_client_lines.amount)`
  ).run(id, line_key, desc, amount);
  res.json(loadFullEstimate(id));
});

// DELETE /client — clear all client-line overrides (rebuild to the scaled default).
router.delete('/client', (req, res) => {
  const id = Number(req.params.id);
  if (!getEstimate(id)) return res.status(404).json({ error: 'estimate not found' });
  db.prepare('DELETE FROM proposal_client_lines WHERE estimate_id = ?').run(id);
  res.json(loadFullEstimate(id));
});

// PUT /:lineId — update a manual line.
// Body: any subset of { description, amount, hidden, keep_in_total, position }
router.put('/:lineId', (req, res) => {
  const id = Number(req.params.id);
  const lineId = Number(req.params.lineId);
  const row = db.prepare('SELECT * FROM proposal_manual_lines WHERE id = ? AND estimate_id = ?').get(lineId, id);
  if (!row) return res.status(404).json({ error: 'manual line not found' });
  const { description, amount, cost, position } = req.body || {};
  const hidden = req.body.hidden != null ? (req.body.hidden ? 1 : 0) : null;
  const keep = 'keep_in_total' in (req.body || {}) ? normKeep(req.body.keep_in_total) : undefined;
  db.prepare(
    `UPDATE proposal_manual_lines SET
       description   = COALESCE(?, description),
       amount        = COALESCE(?, amount),
       cost          = COALESCE(?, cost),
       position      = COALESCE(?, position),
       hidden        = COALESCE(?, hidden),
       keep_in_total = CASE WHEN ? = 1 THEN ? ELSE keep_in_total END
     WHERE id = ? AND estimate_id = ?`
  ).run(
    description != null ? String(description) : null,
    amount != null ? (+amount || 0) : null,
    cost != null ? (+cost || 0) : null,
    position != null ? (+position || 0) : null,
    hidden,
    keep === undefined ? 0 : 1,
    keep === undefined ? null : keep,
    lineId, id
  );
  res.json(loadFullEstimate(id));
});

// DELETE /:lineId — remove a manual line.
router.delete('/:lineId', (req, res) => {
  const id = Number(req.params.id);
  const lineId = Number(req.params.lineId);
  const row = db.prepare('SELECT id FROM proposal_manual_lines WHERE id = ? AND estimate_id = ?').get(lineId, id);
  if (!row) return res.status(404).json({ error: 'manual line not found' });
  db.prepare('DELETE FROM proposal_manual_lines WHERE id = ? AND estimate_id = ?').run(lineId, id);
  res.json(loadFullEstimate(id));
});

module.exports = router;
