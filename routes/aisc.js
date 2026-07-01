'use strict';
const express = require('express');
const db = require('../db');
const router = express.Router();

// GET /api/aisc/lookup?section=W6X25
router.get('/lookup', (req, res) => {
  const section = String(req.query.section || '').toUpperCase().replace(/\s+/g, '');
  if (!section) return res.status(400).json({ error: 'section required' });
  const row = db.prepare('SELECT label, t_f, weight_per_ft FROM aisc_sections WHERE label = ? COLLATE NOCASE').get(section);
  if (!row) return res.json({ found: false, section });
  res.json({ found: true, ...row });
});

// GET /api/aisc?q=W6  -> autocomplete (max 20 results)
router.get('/', (req, res) => {
  const q = String(req.query.q || '').toUpperCase().replace(/\s+/g, '');
  if (!q) {
    const rows = db.prepare('SELECT label, t_f, weight_per_ft FROM aisc_sections LIMIT 20').all();
    return res.json({ rows });
  }
  const rows = db.prepare('SELECT label, t_f, weight_per_ft FROM aisc_sections WHERE label LIKE ? COLLATE NOCASE ORDER BY length(label), label LIMIT 50').all(q + '%');
  res.json({ rows });
});

module.exports = router;
