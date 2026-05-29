'use strict';
const express = require('express');
const { loadFullEstimate } = require('./estimates');
const { generateProposal } = require('../lib/pdf');

const router = express.Router({ mergeParams: true });

router.get('/', (req, res) => {
  const id = Number(req.params.id);
  try {
    const bundle = loadFullEstimate(id);
    if (!bundle) return res.status(404).json({ error: 'not found' });

    // Load exclusions and attach to bundle
    const db = require('../db');
    bundle.standardExclusions = db.prepare(
      'SELECT * FROM standard_exclusions WHERE active = 1 ORDER BY position, id'
    ).all();
    bundle.siteExclusions = db.prepare(
      'SELECT * FROM estimate_site_exclusions WHERE estimate_id = ? ORDER BY position, id'
    ).all(id);

    generateProposal(res, bundle);
  } catch (err) {
    console.error('proposal error:', err);
    res.status(500).json({ error: err.message || 'pdf generation failed' });
  }
});

module.exports = router;
