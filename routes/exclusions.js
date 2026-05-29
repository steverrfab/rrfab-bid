'use strict';
const express = require('express');
const db = require('../db');
const { requireAdmin } = require('../lib/auth');

// Standard exclusions: shared list (admin-managed)
const stdRouter = express.Router();

stdRouter.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM standard_exclusions ORDER BY position, id').all();
  res.json({ rows });
});

stdRouter.post('/', requireAdmin, (req, res) => {
  const { text = '', position } = req.body || {};
  const maxPos = db.prepare('SELECT COALESCE(MAX(position),0) as m FROM standard_exclusions').get().m;
  const pos = position != null ? Number(position) : maxPos + 1;
  const info = db.prepare('INSERT INTO standard_exclusions (text, position, active) VALUES (?, ?, 1)').run(text.trim(), pos);
  const row = db.prepare('SELECT * FROM standard_exclusions WHERE id = ?').get(info.lastInsertRowid);
  res.json(row);
});

stdRouter.put('/:id', requireAdmin, (req, res) => {
  const { id } = req.params;
  const { text, position, active } = req.body || {};
  const row = db.prepare('SELECT * FROM standard_exclusions WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'not found' });
  db.prepare('UPDATE standard_exclusions SET text = ?, position = ?, active = ? WHERE id = ?')
    .run(text != null ? String(text).trim() : row.text,
         position != null ? Number(position) : row.position,
         active != null ? (active ? 1 : 0) : row.active,
         id);
  res.json(db.prepare('SELECT * FROM standard_exclusions WHERE id = ?').get(id));
});

stdRouter.delete('/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM standard_exclusions WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Site-specific exclusions: per-estimate
const siteRouter = express.Router({ mergeParams: true });

siteRouter.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM estimate_site_exclusions WHERE estimate_id = ? ORDER BY position, id').all(req.params.id);
  res.json({ rows });
});

siteRouter.post('/', (req, res) => {
  const { text = '', position } = req.body || {};
  const maxPos = db.prepare('SELECT COALESCE(MAX(position),0) as m FROM estimate_site_exclusions WHERE estimate_id = ?').get(req.params.id).m;
  const pos = position != null ? Number(position) : maxPos + 1;
  const info = db.prepare('INSERT INTO estimate_site_exclusions (estimate_id, text, position) VALUES (?, ?, ?)').run(req.params.id, text.trim(), pos);
  const row = db.prepare('SELECT * FROM estimate_site_exclusions WHERE id = ?').get(info.lastInsertRowid);
  res.json(row);
});

siteRouter.put('/:excId', (req, res) => {
  const { text, position } = req.body || {};
  const row = db.prepare('SELECT * FROM estimate_site_exclusions WHERE id = ? AND estimate_id = ?').get(req.params.excId, req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  db.prepare('UPDATE estimate_site_exclusions SET text = ?, position = ? WHERE id = ?')
    .run(text != null ? String(text).trim() : row.text,
         position != null ? Number(position) : row.position,
         req.params.excId);
  res.json(db.prepare('SELECT * FROM estimate_site_exclusions WHERE id = ?').get(req.params.excId));
});

siteRouter.delete('/:excId', (req, res) => {
  db.prepare('DELETE FROM estimate_site_exclusions WHERE id = ? AND estimate_id = ?').run(req.params.excId, req.params.id);
  res.json({ ok: true });
});

module.exports = { stdRouter, siteRouter };
