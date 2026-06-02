'use strict';

// Process-only / fabrication-only pricing engine.
// Mirrors the RR "Process Only" Excel and the standalone prototype exactly.
//
// Margin comes from labor markup (billed po_labor_rate vs cost po_cost_rate).
// Per-piece processing: P&F = qty * beam_fab_rate, Process = qty * process_rate,
// Manual = proc_manual entered by hand. Processing, galvanize, and additional
// costs are pass-through (cost = price). Subtotal -> O&P -> tax -> quoted price.

function n(v) { const x = parseFloat(v); return Number.isFinite(x) ? x : 0; }

// est: estimate row (po_* columns). lines: process_only_lines rows.
// addcosts: process_only_addcosts rows.
function computeProcess(est, lines, addcosts) {
  const laborRate = n(est.po_labor_rate);
  const costRate  = n(est.po_cost_rate);
  const beamFab   = n(est.po_beam_fab_rate);
  const procRate  = n(est.po_process_rate);
  const galvRate  = n(est.po_galv_rate);
  const opPct     = n(est.po_op_pct);
  const taxPct    = n(est.po_tax_pct);

  let lineSub = 0, totProcessing = 0, totGalv = 0, totHrs = 0;
  const lineRows = (lines || []).map(r => {
    const qty = n(r.qty), hrs = n(r.labor_hrs), wt = n(r.weight_lb);
    let proc = 0;
    if (r.line_type === 'pf') proc = qty * beamFab;
    else if (r.line_type === 'proc') proc = qty * procRate;
    else if (r.line_type === 'manual') proc = n(r.proc_manual);
    const galv = r.galv_on ? wt * galvRate : 0;
    const labor = hrs * laborRate;
    const lineTotal = proc + galv + labor;
    lineSub += lineTotal; totProcessing += proc; totGalv += galv; totHrs += hrs;
    return { id: r.id, processing: proc, galv, labor, lineTotal };
  });

  let addSub = 0;
  const addRows = (addcosts || []).map(r => {
    const input = n(r.input_qty);
    const total = r.is_flat ? input : input * n(r.rate);
    addSub += total;
    return { id: r.id, total };
  });

  const subTotal = lineSub + addSub;
  const opAmt = Math.round(subTotal * opPct);
  const taxAmt = Math.round((subTotal + opAmt) * taxPct);
  const quoted = subTotal + opAmt + taxAmt;

  const laborRev = totHrs * laborRate;
  const laborCost = totHrs * costRate;
  const yourCost = laborCost + totProcessing + totGalv + addSub;
  const gpDollar = quoted - yourCost;
  const gpPct = quoted ? gpDollar / quoted : 0;

  return {
    lineSub, addSub, subTotal, opAmt, taxAmt, quoted,
    totHrs, laborRev, laborCost, laborMargin: laborRev - laborCost,
    totProcessing, totGalv, yourCost, gpDollar, gpPct,
    lineRows, addRows
  };
}

module.exports = { computeProcess };
