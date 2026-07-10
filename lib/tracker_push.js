'use strict';
const { buildProposalView } = require('./proposal_lines');
// Sends a newly-won job to the R&R Project Tracker in real time.
//
// This is deliberately isolated from the database and the estimates route so it
// can be unit-tested on its own and so a tracker problem can never affect the
// bid tool. buildWonJobPayload() turns a loaded estimate bundle into exactly the
// same shape the read-only /feed/won-jobs endpoint returns, so the push and the
// pull always agree. pushWonJobToTracker() is fire-and-forget: it never throws
// into the caller and never blocks marking a bid Won.
//
// Configuration (Railway env vars on the bid service):
//   TRACKER_API_URL  base URL of the tracker, e.g. https://rrfab-project-tracker-production.up.railway.app
//   TRACKER_KEY      the shared secret already used by the pull feed
// If either is missing, the push simply does nothing.

function buildWonJobPayload(bundle) {
  if (!bundle || !bundle.estimate) return null;
  const e = bundle.estimate, c = bundle.computed || {}, pc = bundle.processComputed || {};
  // Only real, confirmed, non-alternate bids belong in the tracker. This mirrors
  // the dashboard totals and the read-only pull feed, so demo, test, superseded,
  // and alternate bids that get marked Won never create a project.
  if (e.bid_type && e.bid_type !== 'real') return null;
  if (e.is_alternate) return null;
  if (!e.confirmed) return null;
  const isPO = e.job_type === 'process_only';
  const ptw = (e.price_to_win != null && e.price_to_win !== '') ? (+e.price_to_win || 0) : null;
  const contract = isPO
    ? (ptw != null ? ptw : ((+pc.subTotal || 0) + (+pc.opAmt || 0)))
    : (ptw != null ? ptw : (+c.totalBid || 0));
  // Real burdened cost, matching the dashboard and proposal (was bid-rate c.directCost).
  const cost = isPO ? (+pc.yourCost || 0) : (+buildProposalView(bundle).base.directCost || 0);
  return {
    job_number: e.job_number, estimate_id: e.id, bid_number: e.bid_number || '',
    project_name: e.project_name || '', client_gc: e.client_gc || '', scope: e.scope || '',
    contract_amount: Math.round(contract),
    cost: Math.round(cost), won_at: e.won_at || null,
    job_type: e.job_type || 'full'
  };
}

function pushWonJobToTracker(bundle) {
  try {
    const base = (process.env.TRACKER_API_URL || '').replace(/\/+$/, '');
    const key = process.env.TRACKER_KEY || '';
    if (!base || !key) return; // integration not configured; do nothing
    const payload = buildWonJobPayload(bundle);
    if (!payload || !payload.job_number) return;
    const url = base + '/api/integration/won-job';
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Integration-Key': key },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    })
      .then(async (r) => {
        if (!r.ok) console.error('[tracker push] job ' + payload.job_number + ' -> status ' + r.status + ': ' + (await r.text().catch(() => '')));
        else console.log('[tracker push] job ' + payload.job_number + ' sent to tracker');
      })
      .catch((e) => console.error('[tracker push] job ' + payload.job_number + ' failed: ' + e.message))
      .finally(() => clearTimeout(timer));
  } catch (e) {
    console.error('[tracker push] error: ' + e.message);
  }
}

module.exports = { buildWonJobPayload, pushWonJobToTracker };
