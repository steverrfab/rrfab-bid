'use strict';

// Process-only / fabrication-only pricing engine.
// Mirrors the RR "Process Only" Excel and the standalone prototype exactly.
//
// Margin comes from labor markup (billed po_labor_rate vs cost po_cost_rate).
// Per-piece processing: P&F = qty * beam_fab_rate, Process = qty * process_rate,
// Manual = proc_manual entered by hand. Processing, galvanize, and additional
// costs are pass-through (cost = price). Subtotal -> O&P -> tax -> quoted price.

function n(v) { const x = parseFloat(v); return Number.isFinite(x) ? x : 0; }

// Classify a line by its shape/size name into beam, channel, angle, or other.
// Handles both the friendly category labels the importer writes ("Beams",
// "Channels", "Angles", "Columns") and raw AISC section codes (W, C, MC, L...).
function shapeCategory(name) {
  const s = String(name || '').toUpperCase();
  // Category-name words first (lines imported grouped by category).
  if (s.includes('ANGLE')) return 'angle';
  if (s.includes('CHANNEL')) return 'channel';
  if (s.includes('BEAM') || s.includes('COLUMN')) return 'beam';
  // Otherwise read the AISC section code.
  const t = s.replace(/\s+/g, '');
  if (!t) return 'other';
  if (t.startsWith('2L') || t[0] === 'L') return 'angle';
  if (t.startsWith('MC') || t[0] === 'C') return 'channel';
  if (t.startsWith('WT') || t.startsWith('ST')) return 'other'; // tees, not beams
  if (t[0] === 'W' || t[0] === 'S' || t.startsWith('HP') || t[0] === 'M') return 'beam';
  return 'other';
}

// Per-piece rate for a line by shape. Uses the matching per-shape rate when it is
// set (> 0); otherwise falls back to the single rate, so existing quotes stay
// identical until the per-shape rates are filled in.
function rateForShape(name, beam, channel, angle, fallback) {
  const cat = shapeCategory(name);
  const rate = cat === 'beam' ? beam : cat === 'channel' ? channel : cat === 'angle' ? angle : 0;
  return rate > 0 ? rate : fallback;
}

// est: estimate row (po_* columns). lines: process_only_lines rows.
// addcosts: process_only_addcosts rows.
function computeProcess(est, lines, addcosts) {
  const laborRate = n(est.po_labor_rate);
  const costRate  = n(est.po_cost_rate);
  const beamFab   = n(est.po_beam_fab_rate);
  const procRate  = n(est.po_process_rate);
  const pfBeam      = n(est.po_pf_rate_beam);
  const pfChannel   = n(est.po_pf_rate_channel);
  const pfAngle     = n(est.po_pf_rate_angle);
  const procBeam    = n(est.po_process_rate_beam);
  const procChannel = n(est.po_process_rate_channel);
  const procAngle   = n(est.po_process_rate_angle);
  const galvRate  = n(est.po_galv_rate);
  const opPct     = n(est.po_op_pct);
  const taxPct    = n(est.po_tax_pct);

  let lineSub = 0, totProcessing = 0, totGalv = 0, totHrs = 0;
  const lineRows = (lines || []).map(r => {
    const qty = n(r.qty), hrs = n(r.labor_hrs), wt = n(r.weight_lb);
    let proc = 0;
    if (r.line_type === 'pf') proc = qty * rateForShape(r.name, pfBeam, pfChannel, pfAngle, beamFab);
    else if (r.line_type === 'proc') proc = qty * rateForShape(r.name, procBeam, procChannel, procAngle, procRate);
    else if (r.line_type === 'manual') proc = n(r.proc_manual);
    const galv = r.galv_on ? wt * galvRate : 0;
    const labor = hrs * laborRate;
    const lineTotal = proc + galv + labor;
    lineSub += lineTotal; totProcessing += proc; totGalv += galv; totHrs += hrs;
    return { id: r.id, processing: proc, galv, labor, lineTotal };
  });

  let addSub = 0, addCostSub = 0, shopLaborHrs = 0, shopLaborRev = 0, shopLaborCost = 0;
  const addRows = (addcosts || []).map(r => {
    const input = n(r.input_qty);
    const total = r.is_flat ? input : input * n(r.rate);
    // Most additional costs are pure pass-through (cost === price). A Shop Labor
    // line (is_labor) bills at its rate but costs at the estimate cost rate, so
    // the labor markup stays in the margin instead of zeroing out.
    let cost = total;
    if (r.is_labor) {
      cost = input * costRate;
      shopLaborHrs += input;
      shopLaborRev += total;
      shopLaborCost += cost;
    }
    addSub += total;
    addCostSub += cost;
    return { id: r.id, total };
  });

  // Process-only bids are quoted in whole dollars too: round the sell subtotal up
  // to the next dollar so O&P, tax, and the quoted price all stay free of cents.
  const subTotal = Math.ceil(lineSub + addSub);
  const opAmt = Math.round(subTotal * opPct);
  const taxAmt = Math.round((subTotal + opAmt) * taxPct);
  const quoted = subTotal + opAmt + taxAmt;

  const lineLaborCost = totHrs * costRate;
  const laborRev = totHrs * laborRate + shopLaborRev;
  const laborCost = lineLaborCost + shopLaborCost;
  const yourCost = lineLaborCost + totProcessing + totGalv + addCostSub;
  // Gross profit is PRE-TAX: sales tax is a pass-through collected for the
  // state, so it never lands in profit. Matches the dashboard (sellPretax),
  // the tax tracker, and how full-project bids are measured (c.totalBid).
  const preTaxTotal = subTotal + opAmt;
  const gpDollar = preTaxTotal - yourCost;
  const gpPct = preTaxTotal ? gpDollar / preTaxTotal : 0;

  return {
    lineSub, addSub, subTotal, opAmt, taxAmt, quoted, preTaxTotal,
    totHrs: totHrs + shopLaborHrs, laborRev, laborCost, laborMargin: laborRev - laborCost,
    totProcessing, totGalv, yourCost, gpDollar, gpPct,
    lineRows, addRows
  };
}

module.exports = { computeProcess };
