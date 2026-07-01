'use strict';
const express = require('express');
const { loadFullEstimate } = require('./estimates');
const { generateProposal } = require('../lib/pdf');
const { buildProposalView } = require('../lib/proposal_lines');

const router = express.Router({ mergeParams: true });

router.get('/', (req, res) => {
  const id = Number(req.params.id);
  try {
    const bundle = loadFullEstimate(id);
    if (!bundle) return res.status(404).json({ error: 'not found' });

    // Block the PDF while any hidden line still has no in-total/excluded choice,
    // so a half-finished edit can never produce a wrong total.
    const view = buildProposalView(bundle);
    if (view.pending > 0) {
      return res.status(409).json({ error: 'pending_line_choice', pending: view.pending,
        message: 'One or more hidden lines still need an "in total" or "excluded" choice before the PDF can be generated.' });
    }

    // Load exclusions and attach to bundle
    const db = require('../db');
    bundle.standardExclusions = db.prepare(
      'SELECT * FROM standard_exclusions WHERE active = 1 ORDER BY position, id'
    ).all();
    bundle.siteExclusions = db.prepare(
      'SELECT * FROM estimate_site_exclusions WHERE estimate_id = ? ORDER BY position, id'
    ).all(id);

    // Enrich shapes with AISC weight per foot for scope page
    const aiscLookup = (label) => {
      if (!label) return 0;
      const row = db.prepare('SELECT weight_per_ft FROM aisc_sections WHERE label = ? COLLATE NOCASE')
        .get(String(label).toUpperCase().replace(/\s+/g, ''));
      return row ? row.weight_per_ft : 0;
    };
    bundle.shapes = (bundle.shapes || []).map(r => ({ ...r, wpf: aiscLookup(r.section_name) }));

    // Attach this bid's alternates (priced separately) so the PDF can list them.
    const altRows = db.prepare(
      'SELECT id FROM estimates WHERE parent_estimate_id = ? AND is_alternate = 1 AND deleted_at IS NULL ORDER BY alt_position, id'
    ).all(id);
    bundle.alternates = altRows
      .map(r => loadFullEstimate(r.id))
      .filter(Boolean);

    generateProposal(res, bundle);
  } catch (err) {
    console.error('proposal error:', err);
    res.status(500).json({ error: err.message || 'pdf generation failed' });
  }
});

module.exports = router;
