'use strict';
const express = require('express');
const db = require('../db');

const router = express.Router();

// GET /api/recipients
router.get('/', (req, res) => {
  const rows = db.prepare(`
    SELECT id, email, name, active, created_at
    FROM notification_recipients
    ORDER BY created_at ASC
  `).all();
  res.json({ rows });
});

// POST /api/recipients  { email, name, active }
router.post('/', (req, res) => {
  const { email, name } = req.body || {};
  const e = String(email || '').trim().toLowerCase();
  if (!e || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) {
    return res.status(400).json({ error: 'valid email required' });
  }
  const active = req.body.active === false ? 0 : 1;
  try {
    const info = db.prepare(`
      INSERT INTO notification_recipients (email, name, active)
      VALUES (?, ?, ?)
      ON CONFLICT(email) DO UPDATE SET name = excluded.name, active = excluded.active
    `).run(e, String(name || '').trim(), active);
    const row = db.prepare('SELECT id, email, name, active, created_at FROM notification_recipients WHERE email = ?').get(e);
    res.status(201).json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/recipients/:id  { email, name, active }
router.put('/:id', (req, res) => {
  const id = Number(req.params.id);
  const exists = db.prepare('SELECT id FROM notification_recipients WHERE id = ?').get(id);
  if (!exists) return res.status(404).json({ error: 'not found' });
  const body = req.body || {};
  const sets = [];
  const vals = [];
  if (body.email != null) {
    const e = String(body.email).trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return res.status(400).json({ error: 'invalid email' });
    sets.push('email = ?'); vals.push(e);
  }
  if (body.name != null) { sets.push('name = ?'); vals.push(String(body.name).trim()); }
  if (body.active != null) { sets.push('active = ?'); vals.push(body.active ? 1 : 0); }
  if (sets.length) {
    vals.push(id);
    db.prepare(`UPDATE notification_recipients SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }
  const row = db.prepare('SELECT id, email, name, active, created_at FROM notification_recipients WHERE id = ?').get(id);
  res.json(row);
});

// DELETE /api/recipients/:id
router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  const info = db.prepare('DELETE FROM notification_recipients WHERE id = ?').run(id);
  if (info.changes === 0) return res.status(404).json({ error: 'not found' });
  res.json({ deleted: id });
});

module.exports = router;
