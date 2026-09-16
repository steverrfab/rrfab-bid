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

// ---- Change orders ----
// Submitted and Approved change orders on a won job are sent to the tracker so
// its contract sum (and the G702 "net change by change orders" line) stays in
// step with the bid tool. Draft, Rejected and deleted ones are sent as
// "removed"; the tracker marks its copy Withdrawn rather than deleting it, and
// never touches one it has already marked Paid.
const CO_STATUS_TO_TRACKER = { Submitted: 'Pending', Approved: 'Approved' };

// The number the office sees: the typed number, or the automatic CO-00N a
// change order written before numbers were typed still carries.
function coNumberOf(co) {
  const typed = String(co.co_number || '').trim();
  return typed || ('CO-' + String(co.seq || 0).padStart(3, '0'));
}

// Takes a hydrated change order (routes/change_orders.js hydrate()). Returns
// null when the change order does not belong in the tracker at all: no parent
// bid, or a parent that is not a Won job with a job number.
function buildChangeOrderPayload(co) {
  if (!co || !co.id) return null;
  const p = co.parent;
  const jobNo = p && p.status === 'Won' && p.job_number != null ? String(p.job_number).trim() : '';
  const trackerStatus = CO_STATUS_TO_TRACKER[co.status] || null;
  const live = !co.deleted_at && !!trackerStatus && !!jobNo;
  const sell = co.computed ? (+co.computed.sell || 0) : 0;
  // Our cost on the change order, so the tracker's margin counts the extra work.
  const cost = co.computed && co.computed.cost != null ? Math.round(+co.computed.cost || 0) : null;
  return {
    co_id: co.id,
    job_number: jobNo,
    estimate_id: co.estimate_id || null,
    co_number: coNumberOf(co),
    title: String(co.title || ''),
    // Pre-tax, the same basis as the job's contract amount.
    amount: Math.round(sell),
    cost,
    bid_status: co.status,
    status: live ? trackerStatus : null,
    removed: !live,
  };
}

function trackerConfig() {
  const base = (process.env.TRACKER_API_URL || '').replace(/\/+$/, '');
  const key = process.env.TRACKER_KEY || '';
  return base && key ? { base, key } : null;
}

// Fire-and-forget, same rules as the won-job push: never throws, never blocks.
function pushChangeOrderToTracker(payload) {
  try {
    const cfg = trackerConfig();
    if (!cfg || !payload || !payload.co_id) return;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    fetch(cfg.base + '/api/integration/change-order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Integration-Key': cfg.key },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    })
      .then(async (r) => {
        // 404 means the job is not in the tracker yet; the tracker pulls change
        // orders itself when the job arrives and again every night.
        if (!r.ok && r.status !== 404) console.error('[tracker push] change order ' + payload.co_id + ' -> status ' + r.status + ': ' + (await r.text().catch(() => '')));
      })
      .catch((e) => console.error('[tracker push] change order ' + payload.co_id + ' failed: ' + e.message))
      .finally(() => clearTimeout(timer));
  } catch (e) {
    console.error('[tracker push] change order error: ' + e.message);
  }
}

// Reads one job's live status and billing from the tracker for the Project tab.
// Resolves to { found: false } when the tracker does not have the job, and
// throws with a plain message when the tracker cannot be reached.
async function fetchTrackerJobStatus(jobNumber) {
  const cfg = trackerConfig();
  if (!cfg) { const e = new Error('Tracker connection not configured'); e.code = 'NOT_CONFIGURED'; throw e; }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const r = await fetch(cfg.base + '/api/integration/job-status?job_number=' + encodeURIComponent(jobNumber), {
      headers: { 'X-Integration-Key': cfg.key },
      signal: ctrl.signal,
    });
    if (r.status === 404) return { found: false };
    if (!r.ok) throw new Error('Tracker answered with status ' + r.status);
    return await r.json();
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('The tracker took too long to answer');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  buildWonJobPayload, pushWonJobToTracker,
  buildChangeOrderPayload, pushChangeOrderToTracker, coNumberOf,
  fetchTrackerJobStatus,
};
