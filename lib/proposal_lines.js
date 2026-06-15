'use strict';

// Shared assembler for the client proposal / SOV pricing lines.
//
// One source of truth used by the proposal PDF, the SOV, and the frontend so
// the line list and the total always agree. It takes the locked calc output
// and applies two user edits on top of it:
//   1. Per-line hide state (built-in lines and Cost Inputs extras).
//   2. Manually added lines (a typed description + dollar amount).
//
// SAFETY: the grand total is NOT rebuilt by summing lines. It stays anchored to
// the calc engine and only moves by a delta:
//   - a line hidden AND excluded from total  -> subtract its amount
//   - a manually added line that is counted   -> add its amount
// With no hidden-excluded lines and no manual lines every delta is zero, so the
// returned subtotal / tax / total are identical to the calc engine output.

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
// carries a stable `key` so its hide state can be looked up and saved.
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
    lines.push({ key: 'po:1', desc: poDesc, amt: (pc.quoted || 0) - (pc.taxAmt || 0) });
  } else {
    lines.push({ key: 'core:1', desc: desc(1), amt: (c.materialPrice || 0) * mf });
    lines.push({ key: 'core:2', desc: desc(2), amt: ((c.fabHours || 0) + (c.paint || 0) + (c.consumables || 0) + (c.handling || 0)) * mf });
    lines.push({ key: 'core:3', desc: desc(3), amt: (((+e.struct_detailing || 0) * (+e.struct_detailing_qty || 1)) + ((+e.misc_detailing || 0) * (+e.misc_detailing_qty || 1)) + ((+e.pe_stamp || 0) * (+e.pe_stamp_qty || 1))) * mf });
    lines.push({ key: 'core:4', desc: desc(4), amt: (+e.freight || 0) * (+e.freight_qty || 1) * mf });
    lines.push({ key: 'core:5', desc: desc(5), amt: ((c.erectionLabor || 0) + (+e.erection_equip || 0) * (+e.erection_equip_qty || 1)) * mf });
    lines.push({ key: 'core:6', desc: desc(6), amt: (c.galv || 0) * mf });
    lines.push({ key: 'core:7', desc: desc(7), amt: (c.processingLabor || 0) * mf });
    if ((+e.sub_joist_deck || 0) > 0) lines.push({ key: 'sub:joist', desc: 'Joist and Deck - by Subcontractor', amt: (+e.sub_joist_deck || 0) * (+e.sub_joist_deck_qty || 1) * mf });
    if ((+e.sub_erection || 0) > 0) lines.push({ key: 'sub:erection', desc: 'Erection - by Subcontractor', amt: (+e.sub_erection || 0) * (+e.sub_erection_qty || 1) * mf });
    extras.forEach(x => lines.push({ key: 'extra:' + x.id, desc: x.description || 'Additional item', amt: (+x.qty || 0) * (+x.rate || 0) * mf }));
  }
  return lines;
}

// Effective sales-tax rate applied to line-level deltas.
function effectiveTaxRate(e) {
  if (e.job_type === 'process_only') return +e.po_tax_pct || 0;
  if (e.tax_mode === 'none') return 0;
  return +e.sales_tax_rate || 0;
}

// Assemble the full proposal view: the ordered line list (built-ins, extras,
// then manual lines) with hide state applied, plus subtotal / tax / total after
// the delta. `pending` counts hidden lines whose keep-in-total choice is unset.
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

  // Locked baseline from the calc engine (never recomputed).
  const baseSubtotal = isPO ? ((pc.quoted || 0) - (pc.taxAmt || 0)) : (c.totalBid || 0);
  const baseTax = isPO ? (pc.taxAmt || 0) : (c.tax ? c.tax.amount : 0);
  const baseTotal = isPO ? (pc.quoted || 0) : (c.totalFurnishInstall || 0);

  let deltaSub = 0;
  let pending = 0;
  const lines = [];

  // Built-in + extras lines, with saved hide state merged in.
  for (const bl of baseLines(bundle)) {
    const v = visByKey[bl.key];
    const hidden = !!(v && v.hidden);
    const keep = v && v.keep_in_total != null ? !!v.keep_in_total : null;
    if (hidden && keep === null) pending++;
    // Excluded from total when hidden and not kept (undecided counts as
    // excluded for the provisional number; callers block output while pending).
    if (hidden && keep !== true) deltaSub -= bl.amt;
    lines.push({
      key: bl.key, desc: bl.desc, amount: bl.amt,
      source: 'builtin', editable: false,
      hidden, keep_in_total: keep
    });
  }

  // Manual lines (always editable, can be hidden/deleted).
  for (const m of manualRows) {
    const hidden = !!m.hidden;
    const keep = m.keep_in_total != null ? !!m.keep_in_total : null;
    if (hidden && keep === null) pending++;
    // Manual line adds to the total when counted (visible, or hidden+kept).
    if (!hidden || keep === true) deltaSub += (+m.amount || 0);
    lines.push({
      key: 'manual:' + m.id, id: m.id, desc: m.description || '', amount: +m.amount || 0,
      source: 'manual', editable: true,
      hidden, keep_in_total: keep, position: +m.position || 0
    });
  }

  const deltaTax = deltaSub * taxRate;
  const subtotal = baseSubtotal + deltaSub;
  const tax = baseTax + deltaTax;
  const total = baseTotal + deltaSub + deltaTax;

  return {
    lines, subtotal, tax, total, taxRate, pending,
    base: { subtotal: baseSubtotal, tax: baseTax, total: baseTotal }
  };
}

module.exports = { buildProposalView, baseLines, markupFactor, effectiveTaxRate, DEFAULT_LINE_DESCS, PO_DEFAULT_DESC };
