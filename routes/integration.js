'use strict';
// Read-only integration endpoint for the Project Tracker to PULL won jobs.
// Protected by a shared secret (INTEGRATION_TOKEN) sent in the
// x-integration-token header. Mounted BEFORE the app's normal user auth, so
// the tracker can call it server-to-server without a user login. It never
// writes anything: it only reads won estimates.
const express = require('express');
const db = require('../db');
const { loadFullEstimate } = require('./estimates');
const { buildProposalView } = require('../lib/proposal_lines');

const router = express.Router();

// Token gate. If the secret is not configured on the server, the endpoint
// stays closed rather than open.
router.use((req, res, next) => {
  const expected = process.env.INTEGRATION_TOKEN;
  if (!expected) return res.status(503).json({ error: 'Integration not configured' });
  const got = req.get('x-integration-token');
  if (!got || got !== expected) return res.status(401).json({ error: 'Bad or missing integration token' });
  next();
});

// GET /api/integration/won-jobs
// Returns every "real" Won estimate that has a job number, with the same
// pre-tax sell price the bid dashboard uses (price-to-win override respected),
// plus the direct cost so the tracker can show margin.
router.get('/won-jobs', (req, res) => {
  try {
    const idRows = db.prepare(
      "SELECT id FROM estimates WHERE status = 'Won' AND deleted_at IS NULL AND confirmed = 1 AND is_alternate = 0 AND (bid_type = 'real' OR bid_type IS NULL) AND job_number IS NOT NULL AND job_number != ''"
    ).all();
    const jobs = [];
    for (const { id } of idRows) {
      const bundle = loadFullEstimate(id);
      if (!bundle) continue;
      const e = bundle.estimate;
      const ptw = (e.price_to_win != null && e.price_to_win !== '') ? (+e.price_to_win || 0) : null;
      let sellPrice, cost;
      if (e.job_type === 'process_only') {
        const pc = bundle.processComputed || {};
        sellPrice = ptw != null ? ptw : ((+pc.subTotal || 0) + (+pc.opAmt || 0));
        cost = (+pc.yourCost || 0);
      } else {
        const c = bundle.computed || {};
        sellPrice = ptw != null ? ptw : (+c.totalBid || 0);
        // Real burdened cost, matching the dashboard and proposal (was bid-rate c.directCost).
        cost = (+buildProposalView(bundle).base.directCost || 0);
      }
      jobs.push({
        jobNumber: e.job_number || '',
        projectName: e.project_name || '',
        clientGc: e.client_gc || '',
        sellPrice: Math.round(sellPrice),
        cost: Math.round(cost),
        wonAt: e.won_at || null,
        bidNumber: e.bid_number || '',
      });
    }
    res.json({ jobs });
  } catch (err) {
    console.error('[integration] won-jobs failed:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
