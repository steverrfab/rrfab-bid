'use strict';
const express = require('express');
const db = require('../db');

const router = express.Router();

router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM contacts ORDER BY name COLLATE NOCASE').all();
  res.json({ rows });
});

router.post('/', (req, res) => {
  const { name, contact_person, phone, email, notes } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'name required' });
  const result = db.prepare(
    `INSERT INTO contacts (name, contact_person, phone, email, notes) VALUES (?, ?, ?, ?, ?)`
  ).run(String(name).trim(), contact_person || '', phone || '', email || '', notes || '');
  res.status(201).json(db.prepare('SELECT * FROM contacts WHERE id = ?').get(result.lastInsertRowid));
});

router.put('/:id', (req, res) => {
  const id = Number(req.params.id);
  const { name, contact_person, phone, email, notes } = req.body || {};
  const exists = db.prepare('SELECT id FROM contacts WHERE id = ?').get(id);
  if (!exists) return res.status(404).json({ error: 'not found' });
  db.prepare(
    `UPDATE contacts SET name=?, contact_person=?, phone=?, email=?, notes=?, updated_at=datetime('now') WHERE id=?`
  ).run(String(name || '').trim(), contact_person || '', phone || '', email || '', notes || '', id);
  res.json(db.prepare('SELECT * FROM contacts WHERE id = ?').get(id));
});

router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  const info = db.prepare('DELETE FROM contacts WHERE id = ?').run(id);
  if (info.changes === 0) return res.status(404).json({ error: 'not found' });
  res.json({ deleted: id });
});

module.exports = router;
