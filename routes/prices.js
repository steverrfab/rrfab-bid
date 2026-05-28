'use strict';
const express = require('express');
const db = require('../db');

const router = express.Router();

router.get('/', (req, res) => {
  const rows = db.prepare('SELECT section_type, rate_per_cwt FROM price_book ORDER BY section_type').all();
  res.json({ rows });
});

router.put('/', (req, res) => {
  const updates = (req.body && req.body.rates) ? req.body.rates : {};
  const stmt = db.prepare(
    `INSERT INTO price_book (section_type, rate_per_cwt, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(section_type) DO UPDATE SET
       rate_per_cwt = excluded.rate_per_cwt,
       updated_at   = excluded.updated_at`
  );
  const tx = db.transaction(() => {
    for (const [type, rate] of Object.entries(updates)) {
      stmt.run(type, +rate || 0);
    }
  });
  tx();
  const rows = db.prepare('SELECT section_type, rate_per_cwt FROM price_book ORDER BY section_type').all();
  res.json({ rows });
});

module.exports = router;
