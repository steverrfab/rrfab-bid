'use strict';

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

// The base (pre-edit) line list, mirroring the proposal PDF exactly. Each line
// carries a stable `key`, its sell `amt`, and its pre-markup `cost`.
function baseLines(bundle) {
  const e = bundle.estimate;
  const c = bundle.computed || {};
  const pc = bundle.processComputed || {};
  const extras = bundle.extras || [];
  const isPO = e.job_type === 'process_only';
  const mf = markupFactor(e);
  const desc = (n) => (e['proposal_line_' + n + '_desc'] || '').trim() || DEFAULT_LINE_DESCS[n - 1];

  const lines = [];
  if (isPO) {
    const poDesc = (e.proposal_line_1_desc || '').trim() || PO_DEFAULT_DESC;
    lines.push({ key: 'po:1', desc: poDesc, amt: (pc.quoted || 0) - (pc.taxAmt || 0), cost: (pc.yourCost || 0) });
  } else {
    const mat = (c.materialPrice || 0);
    lines.push({ key: 'core:1', desc: desc(1), amt: mat * mf, cost: mat });
    const fabFin = (c.fabHours || 0) + (c.paint || 0) + (c.consumables || 0) + (c.handling || 0);
    lines.push({ key: 'core:2', desc: desc(2), amt: fabFin * mf, cost: fabFin });
    const det = ((+e.struct_detailing || 0) * (+e.struct_detailing_qty || 1)) + ((+e.misc_detailing || 0) * (+e.misc_detailing_qty || 1)) + ((+e.pe_stamp || 0) * (+e.pe_stamp_qty || 1));
    lines.push({ key: 'core:3', desc: desc(3), amt: det * mf, cost: det });
    const frt = (+e.freight || 0) * (+e.freight_qty || 1);
    lines.push({ key: 'core:4', desc: desc(4), amt: frt * mf, cost: frt });
    const erect = (c.erectionLabor || 0) + (+e.erection_equip || 0) * (+e.erection_equip_qty || 1);
    lines.push({ key: 'core:5', desc: desc(5), amt: erect * mf, cost: erect });
    lines.push({ key: 'core:6', desc: desc(6), amt: (c.galv || 0) * mf, cost: (c.galv || 0) });
    lines.push({ key: 'core:7', desc: desc(7), amt: (c.processingLabor || 0) * mf, cost: (c.processingLabor || 0) });
    if ((+e.sub_joist_deck || 0) > 0) { const s = (+e.sub_joist_deck || 0) * (+e.sub_joist_deck_qty || 1); lines.push({ key: 'sub:joist', desc: 'Joist and Deck - by Subcontractor', amt: s * mf, cost: s }); }
    if ((+e.sub_erection || 0) > 0) { const s = (+e.sub_erection || 0) * (+e.sub_erection_qty || 1); lines.push({ key: 'sub:erection', desc: 'Erection - by Subcontractor', amt: s * mf, cost: s }); }
    extras.forEach(x => {
      // Section 1 (Material) extras are already inside materialPrice (the
      // material line), so they must not also print as their own line.
      // Sections 2-4 are not in a core line, so they remain itemized here.
      if ((+x.section) === 1) return;
      const s = (+x.qty || 0) * (+x.rate || 0);
      lines.push({ key: 'extra:' + x.id, desc: x.description || 'Additional item', amt: s * mf, cost: s });
    });
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
  const baseDirectCost = isPO ? (pc.yourCost || 0) : (c.directCost || 0);

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

  // Margin base: full job is pre-tax (matches totalBid/directCost); process-only
  // is tax-inclusive (matches the existing gpDollar = quoted - yourCost).
  const marginBase = isPO ? total : finalPretax;
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
