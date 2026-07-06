'use strict';
const express = require('express');
const db = require('../db');
const { normalizeLabel } = require('../lib/sections');
const router = express.Router();

// GET /api/aisc/lookup?section=W6X25
// Matches on the normalized label so equivalent spellings (fractions vs
// decimals, spacing, case) all resolve, e.g. "Pipe 1-1/2 STD" -> Pipe1.5STD.
router.get('/lookup', (req, res) => {
  const section = normalizeLabel(req.query.section || '');
  if (!section) return res.status(400).json({ error: 'section required' });
  const row = db.prepare('SELECT label, t_f, weight_per_ft FROM aisc_sections WHERE label_norm = ?').get(section);
  if (!row) return res.json({ found: false, section });
  res.json({ found: true, ...row });
});

// GET /api/aisc?q=W6  -> autocomplete (max 50 results)
router.get('/', (req, res) => {
  const q = normalizeLabel(req.query.q || '');
  if (!q) {
    const rows = db.prepare('SELECT label, t_f, weight_per_ft FROM aisc_sections LIMIT 20').all();
    return res.json({ rows });
  }
  const rows = db.prepare('SELECT label, t_f, weight_per_ft FROM aisc_sections WHERE label_norm LIKE ? ORDER BY length(label), label LIMIT 50').all(q + '%');
  res.json({ rows });
});

module.exports = router;
