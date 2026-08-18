'use strict';
// Shared bid financials.
//
// The dashboard (/api/estimates/summary) and the Reports downloads
// (/api/reports/*) MUST agree to the penny, so the per-bid revenue/profit rule
// lives here once instead of being copy-pasted into both. Nothing in this file
// touches the database: callers hand in a bundle from loadFullEstimate().

const { buildProposalView } = require('./proposal_lines');

// Revenue = pre-tax sell price. Price-to-win when set, otherwise the computed
// total. Sales tax is a pass-through we collect and remit, so it never lands in
// revenue or profit (the tax owed lives in /api/estimates/tax-summary).
//
// Profit = revenue minus REAL burdened cost (labor at loaded wage rates),
// matching the proposal builder and the Margin Analysis tab — not the old
// bid-rate estimate cost. Hidden/excluded lines do not move these numbers.
function bidFinancials(bundle) {
  const e = bundle.estimate;
  const c = bundle.computed || {};
  const pc = bundle.processComputed || {};
  const ptw = (e.price_to_win != null && e.price_to_win !== '') ? (+e.price_to_win || 0) : null;

  if (e.job_type === 'process_only') {
    const poPreTax = (+pc.subTotal || 0) + (+pc.opAmt || 0);
    const revenue = ptw != null ? ptw : poPreTax;
    return { revenue, profit: revenue - (+pc.yourCost || 0) };
  }

  const view = buildProposalView(bundle);
  const revenue = ptw != null ? ptw : (+c.totalBid || 0);
  return { revenue, profit: revenue - (+view.base.directCost || 0) };
}

// The row shape the dashboard has always returned. Unchanged on purpose.
function summaryRow(bundle) {
  const e = bundle.estimate;
  const { revenue, profit } = bidFinancials(bundle);
  return {
    id: e.id,
    project_name: e.project_name || '',
    bid_number: e.bid_number || '',
    job_type: e.job_type || 'full',
    status: e.status || 'Draft',
    created_at: e.created_at || null,
    submitted_at: e.submitted_at || null,
    won_at: e.won_at || null,
    proposal_date: e.proposal_date || null,
    bid_date: e.bid_date || null,
    revenue,
    profit
  };
}

// Same as summaryRow plus the descriptive columns the Excel reports print.
// Kept separate so the dashboard payload does not grow.
function reportRow(bundle, owner) {
  return {
    ...summaryRow(bundle),
    job_number: bundle.estimate.job_number || '',
    client_gc: bundle.estimate.client_gc || '',
    due_date: bundle.estimate.due_date || null,
    owner_name: (owner && (owner.name || owner.email)) || ''
  };
}

// --- Date handling -----------------------------------------------------------
//
// The timestamp columns are written in DIFFERENT formats: submitted_at is a JS
// ISO string ("2026-07-27T15:10:19.042Z") while won_at comes from SQLite's
// datetime('now') ("2026-07-27 15:10:19"). Comparing them as raw strings puts
// every won_at BELOW any same-day ISO value (a space sorts before 'T'), which
// silently drops Won bids out of a date range. Both formats do start with the
// same YYYY-MM-DD, so every comparison in the reports goes through dayOf().

function dayOf(ts) {
  if (!ts) return null;
  const s = String(ts).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

// Inclusive on both ends. A null from/to means unbounded on that side.
function inRange(ts, from, to) {
  const d = dayOf(ts);
  if (!d) return false;
  if (from && d < from) return false;
  if (to && d > to) return false;
  return true;
}

function monthOf(ts) {
  const d = dayOf(ts);
  return d ? d.slice(0, 7) : null;
}

module.exports = { bidFinancials, summaryRow, reportRow, dayOf, inRange, monthOf };
