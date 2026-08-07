'use strict';

const { subLabel } = require('./sub_labels');

// Shared assembler for the client proposal / SOV pricing lines and the margin.
//
// One source of truth used by the proposal PDF, the SOV, the dashboard, and the
// frontend so the line list, the total, and the margin always agree. It takes
// the locked calc output and layers on:
//   1. Per-line hide state (keep-in-bid vs excluded) for built-ins and extras.
//   2. Manually added lines (a typed description, price, and internal cost).
//   3. A price-to-win override: the final price you choose to quote.
//
// SAFETY: nothing is rebuilt by summing lines. Totals, cost, and margin stay
// anchored to the calc engine and only move by a delta:
//   - a line excluded from the bid      -> subtract its sell AND its cost
//   - a manual line that is counted      -> add its sell AND its cost
//   - a price-to-win override            -> sets the final pre-tax total
// With price_to_win NULL, no excluded lines, and no manual lines, every delta is
// zero, so subtotal / tax / total / cost / margin are identical to the engine.

const DEFAULT_LINE_DESCS = [
  'Structural steel material - furnished',
  'Shop fabrication and finishes',
  'Detailing and PE-stamped shop drawings',
  'Freight to jobsite',
  'Field erection, equipment, and rigging',
  'Finishes',
  'Processing labor'
];

const PO_DEFAULT_DESC = 'Process & fabrication of structural steel per attached scope';

function markupFactor(e) {
  return (1 + (+e.oh_rate || 0))
    * (1 + (+e.contingency_rate || 0))
    * (1 + (+e.profit_rate || 0))
    * (1 + (+e.cgl_rate || 0));
}

// Burdened (fully-loaded) hourly COST per role, matching the Margin Analysis and
// on-screen Client Proposal pages. Falls back to the same defaults the frontend
// uses when an estimate has no wage row yet, so server and screen margins agree.
function burdenedRate(wages, role) {
  const w = (wages || []).find(x => x.role === role);
  if (!w) return 0;
  const base = +w.base_rate || 0;
  const ins = base * ((+w.fica_pct || 0) + (+w.futa_pct || 0) + (+w.suta_pct || 0) + (+w.wc_pct || 0) + (+w.gl_pct || 0) + (+w.umbrella_pct || 0) + (+w.auto_pct || 0) + (+w.pp_bond_pct || 0));
  return base + ins + (+w.health_welfare || 0) + (+w.pension || 0) + base * (+w.consumables_pct || 0) + base * (+w.fuel_pct || 0);
}
function burdenedRates(bundle) {
  const wages = bundle.wages || [];
  return {
    shopRate: burdenedRate(wages, 'shop_worker') || 35.52,
    ironRate: burdenedRate(wages, 'ironworker') || 41.29
  };
}

// The base (pre-edit) line list, mirroring the proposal PDF exactly. Each line
// carries a stable `key`, its sell `amt`, and its pre-markup `cost`.
function baseLines(bundle) {
  const e = bundle.estimate;
  const c = bundle.computed || {};
  const pc = bundle.processComputed || {};
  const extras = bundle.extras || [];
  const isPO = e.job_type === 'process_only';
  const mf = markupFactor(e);
  const { shopRate, ironRate } = burdenedRates(bundle);
  const desc = (n) => (e['proposal_line_' + n + '_desc'] || '').trim() || DEFAULT_LINE_DESCS[n - 1];

  const lines = [];
  if (isPO) {
    const poDesc = (e.proposal_line_1_desc || '').trim() || PO_DEFAULT_DESC;
    lines.push({ key: 'po:1', desc: poDesc, amt: (pc.quoted || 0) - (pc.taxAmt || 0), cost: (pc.yourCost || 0) });
  } else {
    const mat = (c.materialPrice || 0);
    lines.push({ key: 'core:1', desc: desc(1), amt: mat * mf, cost: mat });
    // Cost-Inputs extra rows fold into their section's proposal line instead of
    // printing separately. Material (sec 1) is already inside materialPrice.
    const exTot = (sec) => extras.filter(x => (+x.section) === sec)
      .reduce((s, x) => s + (+x.qty || 0) * (+x.rate || 0), 0);
    const ex2 = exTot(2), ex3 = exTot(3), ex4 = exTot(4);
    // Processing labor is bundled into Shop Fabrication on client-facing output
    // (no separate Processing Labor line). Internal screens still break it out.
    const fabFin = (c.fabHours || 0) + (c.paint || 0) + (c.consumables || 0) + (c.handling || 0) + (c.processingLabor || 0) + ex2 + ex3;
    lines.push({ key: 'core:2', desc: desc(2), amt: fabFin * mf, cost: (+e.fab_mh || 0) * shopRate + (c.paint || 0) + (c.consumables || 0) + (c.handling || 0) + (c.processingLabor || 0) + ex2 + ex3 });
    const det = ((+e.struct_detailing || 0) * (+e.struct_detailing_qty || 1)) + ((+e.misc_detailing || 0) * (+e.misc_detailing_qty || 1)) + ((+e.pe_stamp || 0) * (+e.pe_stamp_qty || 1));
    lines.push({ key: 'core:3', desc: desc(3), amt: det * mf, cost: det });
    const frt = (+e.freight || 0) * (+e.freight_qty || 1);
    lines.push({ key: 'core:4', desc: desc(4), amt: frt * mf, cost: frt });
    const erect = (c.erectionLabor || 0) + (+e.erection_equip || 0) * (+e.erection_equip_qty || 1) + ex4;
    lines.push({ key: 'core:5', desc: desc(5), amt: erect * mf, cost: (+e.erection_mh || 0) * ironRate + (+e.erection_equip || 0) * (+e.erection_equip_qty || 1) + ex4 });
    lines.push({ key: 'core:6', desc: desc(6), amt: (c.galv || 0) * mf, cost: (c.galv || 0) });
    // core:7 (Processing Labor) intentionally removed: bundled into core:2 above.
    if ((+e.sub_joist_deck || 0) > 0) { const s = (+e.sub_joist_deck || 0) * (+e.sub_joist_deck_qty || 1); lines.push({ key: 'sub:joist', desc: subLabel(e.sub_joist_deck_label, 'Joist and Deck - by Subcontractor'), amt: s * mf, cost: s }); }
    if ((+e.sub_erection || 0) > 0) { const s = (+e.sub_erection || 0) * (+e.sub_erection_qty || 1); lines.push({ key: 'sub:erection', desc: subLabel(e.sub_erection_label, 'Erection - by Subcontractor'), amt: s * mf, cost: s }); }
    // Extra rows are folded into the lines above (Material -> core:1 via
    // materialPrice; Fab + Finishes -> core:2; Detailing/Freight/Erection ->
    // core:5). They never print as their own proposal line.
  }
  return lines;
}

// Effective sales-tax rate applied to line-level and price-to-win deltas.
function effectiveTaxRate(e) {
  if (e.job_type === 'process_only') return +e.po_tax_pct || 0;
  if (e.tax_mode === 'none') return 0;
  return +e.sales_tax_rate || 0;
}

function num(v) { return (v != null && v !== '') ? (+v || 0) : null; }

// Assemble the full view: ordered line list (built-ins, extras, manual) with
// hide state, the computed lines total, the price-to-win final total, tax,
// included cost, and margin. `pending` counts hidden lines whose keep choice is
// unset (callers block output while pending).
function buildProposalView(bundle) {
  const e = bundle.estimate;
  const c = bundle.computed || {};
  const pc = bundle.processComputed || {};
  const isPO = e.job_type === 'process_only';
  const visRows = bundle.lineVisibility || [];
  const manualRows = bundle.manualLines || [];
  const taxRate = effectiveTaxRate(e);

  const visByKey = {};
  for (const v of visRows) visByKey[v.line_key] = v;

  // Locked baselines from the calc engine (never recomputed).
  const baseSubtotal = isPO ? ((pc.quoted || 0) - (pc.taxAmt || 0)) : (c.totalBid || 0);
  const baseTax = isPO ? (pc.taxAmt || 0) : (c.tax ? c.tax.amount : 0);
  const baseTotal = isPO ? (pc.quoted || 0) : (c.totalFurnishInstall || 0);
  // Full-project "our cost" is the REAL burdened cost (labor at loaded wage rates),
  // matching the Margin Analysis and on-screen Client Proposal pages, not the
  // bid-rate estimate cost (c.directCost). Process-only already carries real cost.
  const { shopRate, ironRate } = burdenedRates(bundle);
  // Custom line items added in Cost Inputs sections 2-4 (fab / finishes /
  // detailing-freight-erection) are real added cost. The engine folds them into
  // the bid, so they must count on the cost side too or margin is overstated.
  const exCost234 = (bundle.extras || [])
    .filter(x => { const sec = +x.section; return sec === 2 || sec === 3 || sec === 4; })
    .reduce((sum, x) => sum + (+x.qty || 0) * (+x.rate || 0), 0);
  const baseDirectCost = isPO ? (pc.yourCost || 0) : (
    (c.materialPrice || 0)
    + (+e.struct_detailing || 0) * (+e.struct_detailing_qty || 1)
    + (+e.misc_detailing || 0) * (+e.misc_detailing_qty || 1)
    + (+e.pe_stamp || 0) * (+e.pe_stamp_qty || 1)
    + (+e.freight || 0) * (+e.freight_qty || 1)
    + (+e.erection_equip || 0) * (+e.erection_equip_qty || 1)
    + (+e.sub_joist_deck || 0) * (+e.sub_joist_deck_qty || 1)
    + (+e.sub_erection || 0) * (+e.sub_erection_qty || 1)
    + (c.paint || 0) + (c.consumables || 0) + (c.handling || 0)
    + (c.galv || 0) + (c.processingLabor || 0)
    + (+e.fab_mh || 0) * shopRate + (+e.erection_mh || 0) * ironRate
    + exCost234
  );

  let deltaSub = 0;
  let deltaCost = 0;
  let pending = 0;
  const lines = [];

  for (const bl of baseLines(bundle)) {
    const v = visByKey[bl.key];
    const hidden = !!(v && v.hidden);
    const keep = v && v.keep_in_total != null ? !!v.keep_in_total : null;
    if (hidden && keep === null) pending++;
    // Excluded = out of the bid entirely: drop its sell AND its cost. Undecided
    // counts as excluded for the provisional number; callers block while pending.
    if (hidden && keep !== true) { deltaSub -= bl.amt; deltaCost -= bl.cost; }
    lines.push({
      key: bl.key, desc: bl.desc, amount: bl.amt, cost: bl.cost,
      source: 'builtin', editable: false, hidden, keep_in_total: keep
    });
  }

  for (const m of manualRows) {
    const hidden = !!m.hidden;
    const keep = m.keep_in_total != null ? !!m.keep_in_total : null;
    if (hidden && keep === null) pending++;
    const mAmt = +m.amount || 0;
    const mCost = +m.cost || 0;
    if (!hidden || keep === true) { deltaSub += mAmt; deltaCost += mCost; }
    lines.push({
      key: 'manual:' + m.id, id: m.id, desc: m.description || '', amount: mAmt, cost: mCost,
      source: 'manual', editable: true, hidden, keep_in_total: keep, position: +m.position || 0
    });
  }

  const computedTotal = baseSubtotal + deltaSub;      // pre-tax total from the lines
  const includedCost = baseDirectCost + deltaCost;    // cost of the scope you're keeping
  const ptw = num(e.price_to_win);                    // null = use computed
  const finalPretax = ptw != null ? ptw : computedTotal;

  // Tax via delta off the locked base tax, so rounding matches the engine at no-op.
  const tax = baseTax + (finalPretax - baseSubtotal) * taxRate;
  const total = finalPretax + tax;

  // Margin base is pre-tax for BOTH job types: sales tax is a pass-through and
  // must not inflate margin (matches calc_process gpDollar and the dashboard).
  const marginBase = finalPretax;
  const marginDollars = marginBase - includedCost;
  const marginPct = marginBase > 0 ? marginDollars / marginBase : 0;

  return {
    lines, taxRate, pending,
    subtotal: finalPretax, tax, total,
    computedTotal, finalTotal: finalPretax, priceToWin: ptw,
    includedCost, marginDollars, marginPct,
    clientQuoteAmount: num(e.client_quote_amount),
    base: { subtotal: baseSubtotal, tax: baseTax, total: baseTotal, directCost: baseDirectCost }
  };
}

module.exports = { buildProposalView, baseLines, markupFactor, effectiveTaxRate, DEFAULT_LINE_DESCS, PO_DEFAULT_DESC };
