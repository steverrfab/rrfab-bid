'use strict';
const ExcelJS = require('exceljs');
const { detectSectionType } = require('./calc');

// Normalize Unicode fractions to ASCII.
function normalizeSection(s) {
  if (s == null) return '';
  return String(s)
    .replace(/½/g, '1/2')
    .replace(/⅛/g, '1/8')
    .replace(/¼/g, '1/4')
    .replace(/⅜/g, '3/8')
    .replace(/⅝/g, '5/8')
    .replace(/¾/g, '3/4')
    .replace(/⅞/g, '7/8')
    .replace(/\s+/g, '')
    .toUpperCase()
    .trim();
}

function normalizeThickness(s) {
  if (s == null) return '';
  return String(s)
    .replace(/½/g, '1/2').replace(/⅛/g, '1/8').replace(/¼/g, '1/4')
    .replace(/⅜/g, '3/8').replace(/⅝/g, '5/8').replace(/¾/g, '3/4').replace(/⅞/g, '7/8')
    .trim();
}

function cellNumber(cell) {
  if (cell == null) return 0;
  const v = cell.value;
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'object' && v.result != null) return +v.result || 0;
  const n = parseFloat(String(v).replace(/[$,]/g, ''));
  return Number.isFinite(n) ? n : 0;
}
function cellString(cell) {
  if (cell == null) return '';
  const v = cell.value;
  if (v == null) return '';
  if (typeof v === 'object' && v.result != null) return String(v.result);
  return String(v);
}

// Sheet-name to section_type hints.
function sheetTypeHint(name) {
  if (!name) return null;
  const n = String(name).toLowerCase().replace(/\s+/g, '');
  if (n.includes('miscmetal') || n.includes('miscsteel') || n === 'misc') return 'MISC';
  if (n.includes('plate')) return 'PLATE';
  if (n.includes('hss') || n.includes('tube')) return 'HSS';
  if (n.includes('pipe')) return 'PIPE';
  if (n.startsWith('2l') || n.includes('doubleangle') || n.includes('dblangle')) return '2L';
  if (n.startsWith('wt')) return 'WT';
  if (n.includes('langle') || n === 'langles' || n === 'angles') return 'L';
  if (n.includes('channel') || n.startsWith('c&mc') || n.startsWith('candmc')) return 'C';
  if (n.startsWith('sbeam') || n.startsWith('sshape')) return 'S';
  if (n.startsWith('wbeam') || n.startsWith('wshape') || n.startsWith('w&column') || n.startsWith('wandcolumn') || n.startsWith('wcolumn')) return 'W';
  if (n === 'shapes' || n === 'allshapes') return null;
  return null;
}

// Parse one shape sheet. Header expected at row 1: Section, $/CWT, Drop, L1..L8, Notes
function parseShapeSheet(sheet, typeHint, errors, startPos) {
  const rows = [];
  let pos = startPos;
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const section = normalizeSection(cellString(row.getCell(1)));
    if (!section) return;
    let type = typeHint || detectSectionType(section);
    if (!type) { type = detectSectionType(section); }
    if (!type) {
      errors.push(sheet.name + ' row ' + rowNumber + ': unrecognized section "' + section + '"');
      return;
    }
    pos += 1;
    rows.push({
      section_type: type,
      position: pos,
      section_name: section,
      cost_factor: cellNumber(row.getCell(2)),
      drop_ft: cellNumber(row.getCell(3)),
      l1: cellNumber(row.getCell(4)),
      l2: cellNumber(row.getCell(5)),
      l3: cellNumber(row.getCell(6)),
      l4: cellNumber(row.getCell(7)),
      l5: cellNumber(row.getCell(8)),
      l6: cellNumber(row.getCell(9)),
      l7: cellNumber(row.getCell(10)),
      l8: cellNumber(row.getCell(11)),
      notes: cellString(row.getCell(12)).trim()
    });
  });
  return { rows, lastPos: pos };
}

// Parse plates sheet. Header: Thickness, $/CWT, Width (in), Length (in), Qty, Notes
function parsePlatesSheet(sheet, startPos) {
  const rows = [];
  let pos = startPos;
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const thickness = normalizeThickness(cellString(row.getCell(1)));
    const qty = cellNumber(row.getCell(5));
    if (!thickness && !qty) return;
    pos += 1;
    rows.push({
      position: pos,
      thickness,
      cost_factor: cellNumber(row.getCell(2)),
      width_in: cellNumber(row.getCell(3)),
      length_in: cellNumber(row.getCell(4)),
      qty,
      notes: cellString(row.getCell(6)).trim()
    });
  });
  return { rows, lastPos: pos };
}

// Parse misc metals sheet. Header: Description, Qty, Weight Each (lb), $/CWT, Notes
function parseMiscSheet(sheet, startPos) {
  const rows = [];
  let pos = startPos;
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const description = cellString(row.getCell(1)).trim();
    const qty = cellNumber(row.getCell(2));
    const each = cellNumber(row.getCell(3));
    if (!description && !qty && !each) return;
    pos += 1;
    rows.push({
      position: pos,
      description,
      qty,
      weight_each_lb: each,
      cost_per_cwt: cellNumber(row.getCell(4)),
      notes: cellString(row.getCell(5)).trim()
    });
  });
  return { rows, lastPos: pos };
}

// --- External Estimator Format Parser ---
// Handles the outsourced-estimator format: a single "Takeoff" sheet where
// row 9 is the column header (col C = "Section"), and data rows have:
//   col B (2)  = drawing ref   (e.g. "S-101, 10/S-202")
//   col C (3)  = section type  (WF, HSS, ANGLE, PIPE, PLATE, FLAT BAR, etc.)
//   col D (4)  = description   (e.g. "W12x87", "L3x3x1/4 - CROSS BRACING")
//   col G (7)  = total qty (linear ft)
//   col J (10) = total weight lb WITH 10% waste applied
//
// Shape types (WF, HSS, ANGLE, C CHANNEL, MC CHANNEL) go into their proper
// takeoff shape buckets using AISC lookup. Everything else (PIPE - no AISC
// data, PLATE, FLAT BAR, SOLID ROD) lands in Misc Metals with the
// pre-calculated weight so the total is always correct.

// Section types that map to shape rows
const EXTERNAL_SHAPE_MAP = {
  'WF':         'W',
  'HSS':        'HSS',
  'ANGLE':      'L',
  'C CHANNEL':  'C',
  'MC CHANNEL': 'MC',
  'WT':         'WT',
};

// Section types that go to plates
const EXTERNAL_PLATE_TYPES = new Set(['PLATE']);

// Section types that go to misc (PIPE has no AISC data; others are not shapes)
const EXTERNAL_MISC_TYPES = new Set(['PIPE', 'FLAT BAR', 'SOLID ROD']);

const EXTERNAL_KNOWN_SECTIONS = new Set([
  ...Object.keys(EXTERNAL_SHAPE_MAP),
  ...EXTERNAL_PLATE_TYPES,
  ...EXTERNAL_MISC_TYPES
]);

function isExternalEstimatorFormat(wb) {
  const sheet = wb.getWorksheet('Takeoff');
  if (!sheet) return false;
  return cellString(sheet.getRow(9).getCell(3)).trim().toLowerCase() === 'section';
}

// Read $/CWT rates from the SUMMARY sheet (col G label, col H $/lb value).
function readExternalRates(wb) {
  const rates = {};
  const sheet = wb.getWorksheet('SUMMARY');
  if (!sheet) return rates;
  for (let r = 2; r <= 12; r++) {
    const row = sheet.getRow(r);
    const label = cellString(row.getCell(7)).trim();
    const val   = cellNumber(row.getCell(8));
    if (!label || val <= 0) continue;
    const m = label.match(/^(.+?)\s*\/\s*(lb|ib)/i);
    if (m) {
      rates[m[1].trim().toUpperCase()] = Math.round(val * 100);
    }
  }
  return rates;
}

// Convert mixed-fraction leg dimensions to decimal so they match the AISC DB.
// e.g. "L6X3-1/2X3/8" -> "L6X3.5X3/8"
function normalizeMixedFractions(s) {
  return s.replace(/(\d+)-(\d+)\/(\d+)/g, function(_, whole, num, den) {
    return (parseInt(whole, 10) + parseInt(num, 10) / parseInt(den, 10)).toString();
  });
}

// Extract the AISC designation from a description that may include notes.
// "L3x3x1/4 - CROSS BRACING" -> "L3X3X1/4"
// "L6x3-1/2x3/8" -> "L6X3.5X3/8"
function extractDesignation(description) {
  const clean = description.split(' - ')[0].trim();
  return normalizeMixedFractions(normalizeSection(clean));
}

function parseExternalFromWorkbook(wb) {
  const result = { shapes: [], plates: [], misc: [], errors: [] };
  const rates  = readExternalRates(wb);
  const sheet  = wb.getWorksheet('Takeoff');
  if (!sheet) {
    result.errors.push('Takeoff sheet not found');
    return result;
  }

  let shapePos = 0;
  let platePos = 0;
  let miscPos  = 0;

  sheet.eachRow((row, rowNum) => {
    if (rowNum <= 9) return;

    const colB        = cellString(row.getCell(2)).trim();   // drawing ref
    const colC        = cellString(row.getCell(3)).trim();   // section type
    const colD        = cellString(row.getCell(4)).trim();   // description
    const totalQty    = cellNumber(row.getCell(7));          // col G: total linear ft
    const totalWeight = cellNumber(row.getCell(10));         // col J: total lb w/ 10%

    if (!colC || !colD) return;
    if (/^TOTAL\b/i.test(colB)) return;

    const sectionUpper = colC.toUpperCase();
    if (!EXTERNAL_KNOWN_SECTIONS.has(sectionUpper)) return;
    if (totalWeight <= 0) return;

    const notesSuffix = colB ? ' | ' + colB : '';

    if (EXTERNAL_SHAPE_MAP[sectionUpper]) {
      // Goes into the proper shape bucket (W, HSS, L, C, MC).
      // l1 = total linear feet; AISC lookup provides weight/ft.
      // Note: the estimator's pre-calc includes a 10% waste factor;
      // this import uses the raw footage so R&R applies their own waste.
      const sectionType  = EXTERNAL_SHAPE_MAP[sectionUpper];
      const designation  = extractDesignation(colD);
      const rateKey      = sectionUpper === 'C CHANNEL'  ? 'C CHANNEL'
                         : sectionUpper === 'MC CHANNEL' ? 'MC CHANNEL'
                         : sectionUpper;
      shapePos += 1;

      // Warn if weight_per_ft is 0 (AISC lookup failed)
      if (!designation || designation === '') {
        result.errors.push('Row ' + rowNum + ': Could not parse AISC designation from "' + colD + '"');
      }

      result.shapes.push({
        section_type: sectionType,
        position:     shapePos,
        section_name: designation,
        cost_factor:  rates[rateKey] || 0,
        drop_ft:      0,
        l1: totalQty,
        l2: 0, l3: 0, l4: 0, l5: 0, l6: 0, l7: 0, l8: 0,
        notes: colD + notesSuffix
      });
    } else if (EXTERNAL_PLATE_TYPES.has(sectionUpper)) {
      // PLATE - use pre-calculated weight from external estimator
      const rateKey = sectionUpper;
      platePos += 1;
      result.plates.push({
        position:    platePos,
        thickness:   '',  // Plates in external format don't include thickness separately
        cost_factor: rates[rateKey] || 0,
        width_in:    0,
        length_in:   0,
        qty:         1,
        weight_lb:   totalWeight,  // Store the pre-calculated weight
        notes:       '[' + colC + '] ' + colD + notesSuffix
      });
    } else {
      // PIPE, FLAT BAR, SOLID ROD - use pre-calculated weight directly.
      const rateKey = sectionUpper;
      miscPos += 1;
      result.misc.push({
        position:       miscPos,
        description:    '[' + colC + '] ' + colD + notesSuffix,
        qty:            1,
        weight_each_lb: totalWeight,
        cost_per_cwt:   rates[rateKey] || 0,
        notes:          ''
      });
    }
  });

  if (shapePos + platePos + miscPos === 0) {
    result.errors.push('No steel items with weight found in Takeoff sheet');
  }

  return result;
}
// --- End External Estimator Format Parser ---

// Parse the R&R Bid Takeoff Template.
// Supports both the legacy 3-tab format (Instructions / Shapes / Plates)
// and the new per-category multi-tab format (W Beams & Columns, HSS Tube, etc.).
// Also auto-detects the outsourced-estimator single-sheet format.
async function parseTemplate(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);

  if (isExternalEstimatorFormat(wb)) {
    return parseExternalFromWorkbook(wb);
  }

  const result = { shapes: [], plates: [], misc: [], errors: [] };

  let shapePos = 0;
  let platePos = 0;
  let miscPos = 0;

  for (const sheet of wb.worksheets) {
    const name = sheet.name || '';
    if (/^instructions?$/i.test(name)) continue;

    const hint = sheetTypeHint(name);

    if (hint === 'PLATE') {
      const r = parsePlatesSheet(sheet, platePos);
      result.plates.push(...r.rows);
      platePos = r.lastPos;
    } else if (hint === 'MISC') {
      const r = parseMiscSheet(sheet, miscPos);
      result.misc.push(...r.rows);
      miscPos = r.lastPos;
    } else if (hint) {
      const r = parseShapeSheet(sheet, hint, result.errors, shapePos);
      result.shapes.push(...r.rows);
      shapePos = r.lastPos;
    } else {
      const lname = name.toLowerCase();
      if (lname.includes('shape')) {
        const r = parseShapeSheet(sheet, null, result.errors, shapePos);
        result.shapes.push(...r.rows);
        shapePos = r.lastPos;
      }
    }
  }

  return result;
}

function findSheet(wb, pattern) {
  return wb.worksheets.find(s => pattern.test(s.name));
}

module.exports = { parseTemplate, normalizeSection, normalizeThickness };
