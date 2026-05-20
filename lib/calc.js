'use strict';

// R&R Bid calculation engine
// Single source of truth for all derived totals. Mirrors the Excel template logic.

const SHAPE_SECTIONS = ['W', 'WT', 'HSS', 'C', 'MC', 'L', '2L', 'S', 'PIPE'];
const ALL_MATERIAL_SECTIONS = [...SHAPE_SECTIONS, 'PL', 'MISC'];

// Plate thickness lookup -> pounds per square foot
// Steel density: 490 lb/ft^3
// PSF = thickness_in / 12 * 490
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
  // try decimal
  const dec = parseFloat(key);
  if (!Number.isNaN(dec) && dec > 0) return dec / 12 * 490;
  return 0;
}

// Detect section type from section name (e.g. 'W6X25' -> 'W')
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

// Compute totals for one shape row
function computeShapeRow(row, aiscWeightPerFt) {
  const lengths = [row.l1, row.l2, row.l3, row.l4, row.l5, row.l6, row.l7, row.l8].map(v => +v || 0);
  const totalLength = lengths.reduce((a, b) => a + b, 0);
  const dropTotal = (+row.drop_ft || 0) * lengths.filter(x => x > 0).length;
  const lengthWithDrop = totalLength + dropTotal;
  const wpf = +aiscWeightPerFt || 0;
  const totalWeight = wpf * lengthWithDrop;
  const totalPrice = (+row.cost_factor || 0) * totalWeight / 100;
  return { totalLength, totalWeight, totalPrice, weightPerFt: wpf };
}

// Compute totals for one plate row
function computePlateRow(row) {
  const w = +row.width_in || 0;
  const l = +row.length_in || 0;
  const q = +row.qty || 0;
  const sqft = (w * l * q) / 144;
  const psf = plateUnitWeight(row.thickness);
  const totalWeight = sqft * psf;
  const totalPrice = (+row.cost_factor || 0) * totalWeight / 100;
  return { sqft, psf, totalWeight, totalPrice };
}

// Aggregate takeoff totals by section type
function takeoffTotals(shapeRows, plateRows, aiscLookup) {
  const bySection = {};
  for (const s of ALL_MATERIAL_SECTIONS) {
    bySection[s] = { weight: 0, price: 0, length: 0 };
  }
  for (const r of shapeRows) {
    const wpf = aiscLookup(r.section_name);
    const t = computeShapeRow(r, wpf);
    const seg = bySection[r.section_type];
    if (seg) {
      seg.weight += t.totalWeight;
      seg.price += t.totalPrice;
      seg.length += t.totalLength;
    }
  }
  for (const r of plateRows) {
    const t = computePlateRow(r);
    bySection['PL'].weight += t.totalWeight;
    bySection['PL'].price += t.totalPrice;
  }
  return bySection;
}

// Resolve material section value (override OR takeoff fallback)
// Returns { weight, price, source }
function resolveMaterial(section, overrideRow, takeoffSeg) {
  const hasOverride = overrideRow && (
    (overrideRow.weight_lb != null && +overrideRow.weight_lb > 0) ||
    (overrideRow.cost_per_cwt != null && +overrideRow.cost_per_cwt > 0)
  );
  if (hasOverride) {
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

// Compute the full estimate (all sections + totals).
// Inputs:
//   est: estimates table row
//   overrides: array of material_overrides rows
//   shapes: array of takeoff_shapes rows
//   plates: array of takeoff_plates rows
//   aiscLookup: function(label) => weight_per_ft
function compute(est, overrides, shapes, plates, aiscLookup) {
  const takeoff = takeoffTotals(shapes, plates, aiscLookup);

  // Material section by section
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

  // Fab Labor
  const fabHours = (+est.fab_mh || 0) * (+est.fab_rate || 0);
  const processingLabor = materialWeight * (+est.processing_rate || 0);
  const fabLabor = fabHours + processingLabor;

  // Finishes
  // Paint defaults to delivered material weight if no override
  const paintWt = (+est.paint_weight || 0) > 0 ? +est.paint_weight : materialWeight;
  const consWt = (+est.consumables_weight || 0) > 0 ? +est.consumables_weight : materialWeight;
  const handlingWt = (+est.handling_weight || 0) > 0 ? +est.handling_weight : materialWeight;
  const paint = paintWt * (+est.paint_rate || 0);
  const consumables = consWt * (+est.consumables_rate || 0);
  const handling = handlingWt * (+est.handling_rate || 0);
  const galv = (+est.galv_weight || 0) * (+est.galv_rate || 0);
  const finishes = paint + consumables + handling + galv;

  // Detail / Freight / Erection
  const erectionLabor = (+est.erection_mh || 0) * (+est.erection_rate || 0);
  const dfe = (+est.struct_detailing || 0) + (+est.misc_detailing || 0) + (+est.pe_stamp || 0)
    + (+est.freight || 0) + erectionLabor + (+est.erection_equip || 0);

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
  const totalBid = afterCGL;

  // Sales Tax (applied to subtotal for the client proposal)
  const taxRate = +est.sales_tax_rate || 0;
  let taxableBase = totalBid;
  if (est.tax_mode === 'none') taxableBase = 0;
  // 'star' mode would only tax LJB starred items: defer until LJB is computed for v1
  const taxAmount = taxableBase * taxRate;
  const totalFurnishInstall = totalBid + taxAmount;

  // Larger Job Bid totals
  const ljbSteelPrice = materialPrice;
  const ljbShopFab = fabLabor + finishes;
  const ljbShopDwg = (+est.struct_detailing || 0) + (+est.misc_detailing || 0) + (+est.pe_stamp || 0)
    + (+est.ljb_shop_dwg_pages || 0) * 350;
  const ljbGalv = (+est.ljb_galv_lbs || 0) * (+est.ljb_galv_rate || 0)
    + (+est.ljb_aess_lbs || 0) * (+est.ljb_aess_rate || 0);
  const ljbErect = (+est.ljb_erect_sub1 || 0) + (+est.ljb_erect_sub2 || 0) + erectionLabor + (+est.erection_equip || 0);
  const ljbJoist = (+est.ljb_joist_sub1 || 0) + (+est.ljb_joist_sub2 || 0);
  const distance = +est.ljb_distance_miles || 0;
  const tons = (+est.ljb_tons || 0) > 0 ? +est.ljb_tons : materialWeight / 2000;
  const trips = Math.ceil((tons * 2000) / 20000) || 0;
  const ljbTrucking = (+est.freight || 0); // use freight from Cost Inputs as the freight number for now
  const ljbSubtotal = ljbSteelPrice + ljbTrucking + ljbGalv + ljbShopFab + ljbShopDwg + ljbErect + ljbJoist;
  const ljbOP = ljbSubtotal * (+est.ljb_op_rate || 0);
  const ljbTotal = Math.ceil((ljbSubtotal + ljbOP) / 5) * 5;

  // Benchmark $/lb
  const bidPerLb = materialWeight > 0 ? totalBid / materialWeight : 0;

  return {
    material,
    materialWeight,
    materialPrice,
    fabHours,
    processingLabor,
    fabLabor,
    paint, consumables, handling, galv, finishes,
    erectionLabor, dfe,
    directCost,
    markup: {
      oh:      directCost * ohRate,
      cont:    afterOH * contRate,
      profit:  afterCont * profitRate,
      cgl:     afterProfit * cglRate,
      afterOH, afterCont, afterProfit, afterCGL
    },
    totalBid,
    tax: { rate: taxRate, base: taxableBase, amount: taxAmount },
    totalFurnishInstall,
    ljb: {
      steelPrice: ljbSteelPrice,
      trucking: ljbTrucking,
      galv: ljbGalv,
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
  takeoffTotals,
  resolveMaterial,
  compute
};
