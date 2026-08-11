'use strict';

// R&R Bid calculation engine
// Single source of truth for all derived totals. Mirrors the Excel template logic.

const SHAPE_SECTIONS = ['W', 'WT', 'HSS', 'C', 'MC', 'L', '2L', 'S', 'PIPE'];
const ALL_MATERIAL_SECTIONS = [...SHAPE_SECTIONS, 'PL', 'MISC'];

// Plate thickness lookup -> pounds per square foot
// Steel density: 490 lb/ft^3
const PLATE_PSF = {
  '3/16': 0.1875 / 12 * 490,
  '1/4':  0.25   / 12 * 490,
  '5/16': 0.3125 / 12 * 490,
  '3/8':  0.375  / 12 * 490,
  '7/16': 0.4375 / 12 * 490,
  '1/2':  0.5    / 12 * 490,
  '9/16': 0.5625 / 12 * 490,
  '5/8':  0.625  / 12 * 490,
  '11/16':0.6875 / 12 * 490,
  '3/4':  0.75   / 12 * 490,
  '13/16':0.8125 / 12 * 490,
  '7/8':  0.875  / 12 * 490,
  '15/16':0.9375 / 12 * 490,
  '1':    1.0    / 12 * 490,
  '1 1/4': 1.25 / 12 * 490,
  '1 1/2': 1.5  / 12 * 490,
  '2':     2.0  / 12 * 490
};

function plateUnitWeight(thickness) {
  if (thickness == null) return 0;
  const key = String(thickness).trim();
  if (PLATE_PSF[key] != null) return PLATE_PSF[key];
  const dec = parseFloat(key);
  if (!Number.isNaN(dec) && dec > 0) return dec / 12 * 490;
  return 0;
}

function detectSectionType(name) {
  if (!name) return '';
  const s = String(name).trim().toUpperCase();
  if (s.startsWith('HSS')) return 'HSS';
  if (s.startsWith('PIPE')) return 'PIPE';
  if (s.startsWith('2L')) return '2L';
  if (s.startsWith('MC')) return 'MC';
  if (s.startsWith('WT')) return 'WT';
  if (s.startsWith('ST')) return 'WT';
  const c = s[0];
  if (c === 'W') return 'W';
  if (c === 'C') return 'C';
  if (c === 'L') return 'L';
  if (c === 'S') return 'S';
  return '';
}

function computeShapeRow(row, aiscWeightPerFt) {
  // l<n> is a piece length in feet; q<n> is how many pieces are that long.
  // A filled length slot with no count (q = 0) still counts as one piece, so
  // legacy rows saved before per-piece counts existed price exactly as before.
  const lengths = [row.l1, row.l2, row.l3, row.l4, row.l5, row.l6, row.l7, row.l8].map(v => +v || 0);
  const counts  = [row.q1, row.q2, row.q3, row.q4, row.q5, row.q6, row.q7, row.q8].map(v => +v || 0);
  let totalLength = 0;
  let pieces = 0;
  for (let i = 0; i < lengths.length; i++) {
    if (lengths[i] > 0) {
      const n = counts[i] > 0 ? counts[i] : 1;
      totalLength += lengths[i] * n;
      pieces += n;
    }
  }
  // Drop is per size, carried on the row, and can be expressed two ways.
  //
  // drop_ft is the original form: extra feet charged once per physical piece,
  // not once per filled slot. Bids entered before the percentage form existed
  // still carry it, so it is still honoured and must not be removed.
  //
  // drop_pct is the current form: a percentage uplift on the row's weight. It
  // defaults to 0, which multiplies by 1 and leaves every pre-existing row
  // pricing exactly as it did before drop_pct was added.
  const dropTotal = (+row.drop_ft || 0) * pieces;
  const lengthWithDrop = totalLength + dropTotal;
  const wpf = +aiscWeightPerFt || 0;
  const totalWeight = wpf * lengthWithDrop * (1 + (+row.drop_pct || 0) / 100);
  const totalPrice = (+row.cost_factor || 0) * totalWeight / 100;
  return { totalLength, totalWeight, totalPrice, weightPerFt: wpf, pieces };
}

function computePlateRow(row) {
  // weight_lb is the weight an outside estimator supplied for this row on
  // import. When it is set it wins outright: it is the number that was quoted,
  // and the plate dimensions behind it may be approximate or missing.
  //
  // That means a hand edit to thickness, width, length or qty cannot move the
  // weight of a row that still carries an imported weight. Editing any of those
  // four fields in the Takeoff grid therefore clears weight_lb on that row,
  // which drops it through to the calculation below. Do not "fix" this by
  // recalculating over a live weight_lb -- that would reprice imported rows
  // nobody touched.
  //
  // Square footage is still reported off the dimensions for display. It is not
  // part of the weight or the price on this branch.
  if (row.weight_lb && +row.weight_lb > 0) {
    const totalWeight = +row.weight_lb;
    const totalPrice = (+row.cost_factor || 0) * totalWeight / 100;
    const sqft = ((+row.width_in || 0) * (+row.length_in || 0) * (+row.qty || 0)) / 144;
    return { sqft, psf: plateUnitWeight(row.thickness), totalWeight, totalPrice };
  }
  // Otherwise calculate from thickness, width, length, qty
  const w = +row.width_in || 0;
  const l = +row.length_in || 0;
  const q = +row.qty || 0;
  const sqft = (w * l * q) / 144;
  const psf = plateUnitWeight(row.thickness);
  const totalWeight = sqft * psf;
  const totalPrice = (+row.cost_factor || 0) * totalWeight / 100;
  return { sqft, psf, totalWeight, totalPrice };
}

// Misc metals: priced by length (ft) x $/ft, entered by hand. No weight
// contribution -- misc is not priced by the pound, so it does not add to
// tonnage or weight-driven costs. Legacy rows saved under the old
// qty x weight-each x $/CWT model still compute that way until re-entered.
function computeMiscRow(row) {
  const lengthFt = +row.length_ft || 0;
  const pricePerFt = +row.price_per_ft || 0;
  if (lengthFt > 0 || pricePerFt > 0) {
    return { totalWeight: 0, totalPrice: lengthFt * pricePerFt };
  }
  const qty = +row.qty || 0;
  const each = +row.weight_each_lb || 0;
  const totalWeight = qty * each;
  const totalPrice = (+row.cost_per_cwt || 0) * totalWeight / 100;
  return { totalWeight, totalPrice };
}

// Aggregate takeoff totals by section type.
// New signature: takeoffTotals(shapeRows, plateRows, miscRows, aiscLookup)
// Old (back-compat): takeoffTotals(shapeRows, plateRows, aiscLookup)
function takeoffTotals(shapeRows, plateRows, miscRows, aiscLookup) {
  if (typeof miscRows === 'function') {
    aiscLookup = miscRows;
    miscRows = [];
  }
  const bySection = {};
  for (const s of ALL_MATERIAL_SECTIONS) {
    bySection[s] = { weight: 0, price: 0, length: 0 };
  }
  for (const r of (shapeRows || [])) {
    let wpf = aiscLookup ? aiscLookup(r.section_name) : 0;
    // Fallback: if the section is not in the AISC table (lookup returns 0), use the
    // hand-entered manual weight/ft so non-standard / built-up pieces still compute.
    if (!(wpf > 0)) wpf = +r.manual_wpf || 0;
    const t = computeShapeRow(r, wpf);
    const seg = bySection[r.section_type];
    if (seg) {
      seg.weight += t.totalWeight;
      seg.price += t.totalPrice;
      seg.length += t.totalLength;
    }
  }
  for (const r of (plateRows || [])) {
    const t = computePlateRow(r);
    bySection['PL'].weight += t.totalWeight;
    bySection['PL'].price += t.totalPrice;
  }
  for (const r of (miscRows || [])) {
    const t = computeMiscRow(r);
    bySection['MISC'].weight += t.totalWeight;
    bySection['MISC'].price += t.totalPrice;
  }
  return bySection;
}

function resolveMaterial(section, overrideRow, takeoffSeg) {
  // "Last touched wins": if source='takeoff', skip override values and use takeoff
  // even if weight_lb is non-zero (user switched back to takeoff after manual entry).
  const isManual = overrideRow &&
    overrideRow.source !== 'takeoff' && (
      (overrideRow.weight_lb != null && +overrideRow.weight_lb > 0) ||
      (overrideRow.cost_per_cwt != null && +overrideRow.cost_per_cwt > 0)
    );
  if (isManual) {
    const w = +overrideRow.weight_lb || 0;
    const cwt = +overrideRow.cost_per_cwt || 0;
    return { weight: w, price: w * cwt / 100, source: 'manual', cwt };
  }
  if (takeoffSeg && (takeoffSeg.weight > 0 || takeoffSeg.price > 0)) {
    const cwt = takeoffSeg.weight > 0 ? (takeoffSeg.price / takeoffSeg.weight * 100) : 0;
    return { weight: takeoffSeg.weight, price: takeoffSeg.price, source: 'takeoff', cwt };
  }
  return { weight: 0, price: 0, source: 'empty', cwt: 0 };
}

// compute(est, overrides, shapes, plates, miscRows, aiscLookup[, extras])
// extras: array of estimate_extras rows from the DB.
//   section 1: qty*rate adds to materialPrice; weight_lb adds to materialWeight
//   section 2: qty*rate adds to fabLabor
//   section 3: qty*rate adds to finishes
//   section 4: qty*rate adds to dfe
// Old (back-compat): compute(est, overrides, shapes, plates, aiscLookup)
function compute(est, overrides, shapes, plates, miscRows, aiscLookup, extras) {
  if (typeof miscRows === 'function') {
    aiscLookup = miscRows;
    miscRows = [];
  }
  extras = extras || [];
  const takeoff = takeoffTotals(shapes, plates, miscRows, aiscLookup);

  const material = {};
  let materialWeight = 0;
  let materialPrice = 0;
  for (const sec of ALL_MATERIAL_SECTIONS) {
    const ov = overrides.find(o => o.section === sec);
    const r = resolveMaterial(sec, ov, takeoff[sec]);
    material[sec] = r;
    materialWeight += r.weight;
    materialPrice += r.price;
  }

  // Section 1 custom extras: add weight and cost to material totals
  const sec1Extras = extras.filter(x => x.section === 1);
  let extrasWeightSec1 = 0;
  let extrasCostSec1 = 0;
  for (const x of sec1Extras) {
    extrasWeightSec1 += +x.weight_lb || 0;
    extrasCostSec1 += (+x.qty || 0) * (+x.rate || 0);
  }
  materialWeight += extrasWeightSec1;
  materialPrice += extrasCostSec1;

  // Fab Labor
  const fabHours = (+est.fab_mh || 0) * (+est.fab_rate || 0);
  const processingLabor = materialWeight * (+est.processing_rate || 0);
  const sec2ExtrasTotal = extras.filter(x => x.section === 2)
    .reduce((s, x) => s + (+x.qty || 0) * (+x.rate || 0), 0);
  const fabLabor = fabHours + processingLabor + sec2ExtrasTotal;

  // Finishes
  const paintWt = +est.paint_weight || 0;
  const consWt = +est.consumables_weight || 0;
  const handlingWt = +est.handling_weight || 0;
  const paint = paintWt * (+est.paint_rate || 0);
  const consumables = consWt * (+est.consumables_rate || 0);
  const handling = handlingWt * (+est.handling_rate || 0);
  const galv = (+est.galv_weight || 0) * (+est.galv_rate || 0);
  const sec3ExtrasTotal = extras.filter(x => x.section === 3)
    .reduce((s, x) => s + (+x.qty || 0) * (+x.rate || 0), 0);
  const finishes = paint + consumables + handling + galv + sec3ExtrasTotal;

  // Detail / Freight / Erection
  const erectionLabor = (+est.erection_mh || 0) * (+est.erection_rate || 0);
  const sec4ExtrasTotal = extras.filter(x => x.section === 4)
    .reduce((s, x) => s + (+x.qty || 0) * (+x.rate || 0), 0);
  const subJoistDeck = (+est.sub_joist_deck || 0) * (+est.sub_joist_deck_qty || 1);
  const subErection  = (+est.sub_erection  || 0) * (+est.sub_erection_qty  || 1);
  const dfe = (+est.struct_detailing || 0) * (+est.struct_detailing_qty || 1)
    + (+est.misc_detailing || 0) * (+est.misc_detailing_qty || 1)
    + (+est.pe_stamp || 0) * (+est.pe_stamp_qty || 1)
    + (+est.freight || 0) * (+est.freight_qty || 1)
    + erectionLabor + (+est.erection_equip || 0) * (+est.erection_equip_qty || 1) + sec4ExtrasTotal
    + subJoistDeck + subErection;

  const directCost = materialPrice + fabLabor + finishes + dfe;

  // Markup cascade
  const ohRate = +est.oh_rate || 0;
  const contRate = +est.contingency_rate || 0;
  const profitRate = +est.profit_rate || 0;
  const cglRate = +est.cgl_rate || 0;
  const afterOH = directCost * (1 + ohRate);
  const afterCont = afterOH * (1 + contRate);
  const afterProfit = afterCont * (1 + profitRate);
  const afterCGL = afterProfit * (1 + cglRate);
  // Bids are quoted in whole dollars: round the sell price up to the next dollar.
  // This is the single source of truth, so the dashboard, won-jobs feed,
  // proposal and SOV all inherit a whole-dollar total from here.
  const totalBid = Math.ceil(afterCGL);

  // Sales Tax. Tax is a pass-through, but it is also rounded up to a whole
  // dollar so the furnish+install total stays free of cents.
  const taxRate = +est.sales_tax_rate || 0;
  let taxableBase = totalBid;
  if (est.tax_mode === 'none') taxableBase = 0;
  const taxAmount = Math.ceil(taxableBase * taxRate);
  const totalFurnishInstall = totalBid + taxAmount;

  // Larger Job Bid totals
  const ljbSteelPrice = materialPrice;
  // Galvanize is shown as its own line in the LJB format, so exclude it from the
  // bundled Shop Fabrication (finishes includes galv) or it double-counts.
  const ljbShopFab = fabLabor + finishes - galv;
  const ljbShopDwg = (+est.struct_detailing || 0) * (+est.struct_detailing_qty || 1)
    + (+est.misc_detailing || 0) * (+est.misc_detailing_qty || 1)
    + (+est.pe_stamp || 0) * (+est.pe_stamp_qty || 1)
    + (+est.ljb_shop_dwg_pages || 0) * 350;
  // Use the LJB's own galv fields when entered, else fall back to the Cost Inputs
  // galv so it is never dropped. Counted once here, not inside Shop Fabrication.
  const ljbGalvFieldsSet = (+est.ljb_galv_lbs || 0) > 0 || (+est.ljb_galv_rate || 0) > 0;
  const ljbGalvOnly = ljbGalvFieldsSet ? (+est.ljb_galv_lbs || 0) * (+est.ljb_galv_rate || 0) : galv;
  const ljbAess = (+est.ljb_aess_lbs || 0) * (+est.ljb_aess_rate || 0);
  const ljbGalv = ljbGalvOnly + ljbAess;
  const ljbErect = (+est.ljb_erect_sub1 || 0) + (+est.ljb_erect_sub2 || 0) + erectionLabor + (+est.erection_equip || 0) * (+est.erection_equip_qty || 1);
  const ljbJoist = (+est.ljb_joist_sub1 || 0) + (+est.ljb_joist_sub2 || 0);
  const tons = (+est.ljb_tons || 0) > 0 ? +est.ljb_tons : materialWeight / 2000;
  const trips = Math.ceil((tons * 2000) / 20000) || 0;
  const ljbTrucking = (+est.freight || 0) * (+est.freight_qty || 1);
  const ljbSubtotal = ljbSteelPrice + ljbTrucking + ljbGalv + ljbShopFab + ljbShopDwg + ljbErect + ljbJoist;
  const ljbOP = ljbSubtotal * (+est.ljb_op_rate || 0);
  const ljbTotal = Math.ceil((ljbSubtotal + ljbOP) / 5) * 5;

  const bidPerLb = materialWeight > 0 ? totalBid / materialWeight : 0;

  return {
    material,
    materialWeight,
    materialPrice,
    fabHours,
    processingLabor,
    fabLabor,
    paint, consumables, handling, galv, finishes,
    erectionLabor, subJoistDeck, subErection, dfe,
    directCost,
    markup: {
      oh:      directCost * ohRate,
      cont:    afterOH * contRate,
      profit:  afterCont * profitRate,
      cgl:     afterProfit * cglRate,
      afterOH, afterCont, afterProfit, afterCGL
    },
    totalBid,
    sellPrice: totalBid,
    marginPct: totalBid > 0 ? (totalBid - directCost) / totalBid : 0,
    tax: { rate: taxRate, base: taxableBase, amount: taxAmount },
    totalFurnishInstall,
    ljb: {
      steelPrice: ljbSteelPrice,
      trucking: ljbTrucking,
      galv: ljbGalvOnly,
      aess: ljbAess,
      shopFab: ljbShopFab,
      shopDwg: ljbShopDwg,
      erect: ljbErect,
      joist: ljbJoist,
      subtotal: ljbSubtotal,
      op: ljbOP,
      total: ljbTotal,
      tons,
      trips
    },
    benchmark: { bidPerLb }
  };
}

module.exports = {
  SHAPE_SECTIONS,
  ALL_MATERIAL_SECTIONS,
  PLATE_PSF,
  plateUnitWeight,
  detectSectionType,
  computeShapeRow,
  computePlateRow,
  computeMiscRow,
  takeoffTotals,
  resolveMaterial,
  compute
};
