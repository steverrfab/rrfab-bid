'use strict';
const express = require('express');
const db = require('../db');

const router = express.Router();

const NOTES_KEY = 'proposal_default_notes';
const TERMS_KEY = 'proposal_default_terms';

function getValue(key) {
  const row = db.prepare('SELECT value FROM settings_kv WHERE key = ?').get(key);
  return row ? row.value : '';
}

function setValue(key, value) {
  db.prepare(
    `INSERT INTO settings_kv (key, value, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       updated_at = excluded.updated_at`
  ).run(key, String(value == null ? '' : value));
}

router.get('/', (req, res) => {
  res.json({ notes: getValue(NOTES_KEY), terms: getValue(TERMS_KEY) });
});

router.put('/', (req, res) => {
  const { notes, terms } = req.body || {};
  if (notes != null) setValue(NOTES_KEY, notes);
  if (terms != null) setValue(TERMS_KEY, terms);
  res.json({ notes: getValue(NOTES_KEY), terms: getValue(TERMS_KEY) });
});

module.exports = router;
