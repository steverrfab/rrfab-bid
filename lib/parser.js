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
    .replace(/["']/g, '')   // strip inch/foot marks
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
// Handles the outsourced-estimator format. The header row (row 9) has col C
// labeled "Section", and data rows below have:
//   col B (2)  = drawing ref   (e.g. "S-101, 10/S-202")
//   col C (3)  = section type  (WF, HSS, ANGLE, C CHANNEL, MC CHANNEL, PLATE...)
//   col D (4)  = description   (e.g. "W12X87", "Column - W10x33", "L3x3x1/4 - BRACING")
//   col G (7)  = total qty (linear ft)
//   col J (10) = total weight lb (estimator's pre-calc, includes ~10% waste)
//
// A workbook can contain MULTIPLE takeoff sheets (one per building), each named
// like "Takeoff - <Building>"; all are parsed and combined. Every section type
// is handled: structural shapes route to their AISC shape buckets, plates to
// plates, and all other carbon-steel items (pipe, grating, deck, pan, etc.) to
// Misc with the file's pre-calc weight. Hardware, stainless (SS), and aluminum
// (ALUM) are intentionally held back and reported in `skipped`, never silently
// dropped.

// Synonyms in col C -> internal shape section_type.
const EXTERNAL_SHAPE_MAP = {
  'WF': 'W', 'W BEAM': 'W', 'W-BEAM': 'W', 'WIDE FLANGE': 'W', 'BEAM': 'W', 'W': 'W',
  'S BEAM': 'S', 'S-BEAM': 'S', 'S': 'S',
  'M BEAM': 'M', 'M': 'M', 'HP': 'HP',
  'HSS': 'HSS', 'TUBE': 'HSS', 'TUBING': 'HSS', 'HSS TUBE': 'HSS', 'TUBE STEEL': 'HSS',
  'ANGLE': 'L', 'ANGLES': 'L', 'L ANGLE': 'L', 'L': 'L',
  '2L': '2L', 'DOUBLE ANGLE': '2L', 'DBL ANGLE': '2L',
  'C CHANNEL': 'C', 'CHANNEL': 'C', 'C': 'C',
  'MC CHANNEL': 'MC', 'MC': 'MC',
  'WT': 'WT', 'ST': 'WT', 'TEE': 'WT', 'WT TEE': 'WT'
};

// internal type -> SUMMARY rate label (col G in the SUMMARY sheet)
const RATE_LABEL_BY_TYPE = {
  'W': 'WF', 'S': 'WF', 'M': 'WF', 'HP': 'WF',
  'HSS': 'HSS', 'L': 'ANGLE', '2L': 'ANGLE',
  'C': 'C CHANNEL', 'MC': 'MC CHANNEL', 'WT': 'WF'
};

const EXTERNAL_PLATE_TYPES = new Set(['PLATE', 'BENT PLATE', 'CHECKERED PLATE']);

// Other carbon-steel items -> Misc, using the file's pre-calc weight.
const EXTERNAL_MISC_TYPES = new Set([
  'PIPE', 'FLAT BAR', 'SOLID ROD', 'ROUND BAR', 'SQUARE BAR',
  'METAL DECK', 'DECK', 'METAL PAN', 'PAN', 'GRATING', 'BAR GRATING',
  'DIAMOND PLATE', 'POUR STOP', 'EMBED', 'EMBEDS', 'MISC', 'MISC METAL', 'MISC METALS'
]);

// Held back for now (reported, not imported): hardware + non-carbon materials.
function heldKind(cu) {
  if (cu === 'HARDWARE' || cu === 'BOLTS' || cu === 'ANCHOR BOLTS') return 'hardware';
  if (cu.startsWith('SS') || cu.startsWith('STAINLESS')) return 'stainless';
  if (cu.startsWith('ALUM')) return 'aluminum';
  return null;
}

// A purely numeric / total cell is a footer artifact, not a section type.
function isJunkSection(cu, colB) {
  if (!cu) return true;
  if (/^TOTAL\b/i.test(colB) || /^TOTAL\b/i.test(cu)) return true;
  if (/^[\d.,\s]+$/.test(cu)) return true; // numbers only
  return false;
}

function isExternalEstimatorFormat(wb) {
  return externalTakeoffSheets(wb).length > 0;
}

// Every worksheet whose row-9 col C reads "Section" is a takeoff sheet.
function externalTakeoffSheets(wb) {
  return wb.worksheets.filter(ws => {
    try {
      return cellString(ws.getRow(9).getCell(3)).trim().toLowerCase() === 'section';
    } catch (e) { return false; }
  });
}

// Read $/CWT rates from a SUMMARY sheet (col G label, col H $/lb value).
// For multi-sheet workbooks, the SUMMARY sheet paired with a given takeoff sheet
// shares its name suffix ("Takeoff - X" <-> "SUMMARY - X").
function readExternalRates(wb, takeoffSheetName) {
  const rates = {};
  let sheet = null;
  if (takeoffSheetName) {
    const want = takeoffSheetName.replace(/takeoff/i, 'SUMMARY').trim().toLowerCase();
    sheet = wb.worksheets.find(s => s.name.trim().toLowerCase() === want) || null;
  }
  if (!sheet) sheet = wb.getWorksheet('SUMMARY')
    || wb.worksheets.find(s => /^summary/i.test(s.name)) || null;
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

// AISC designation patterns, scanned anywhere in the (normalized) description so
// "Column - W10X33" or "STRINGER - C12X14.3" still resolve to the real shape.
const DESIG_PATTERNS = {
  W:  /W\d+(?:\.\d+)?X[\d.]+/,
  S:  /S\d+(?:\.\d+)?X[\d.]+/,
  M:  /M\d+(?:\.\d+)?X[\d.]+/,
  HP: /HP\d+(?:\.\d+)?X[\d.]+/,
  MC: /MC\d+(?:\.\d+)?X[\d.]+/,
  C:  /(?<![A-Z])C\d+(?:\.\d+)?X[\d.]+/,
  WT: /WT\d+(?:\.\d+)?X[\d.]+/,
  L:  /L[\d./]+X[\d./]+X[\d./]+/,
  '2L': /2L[\d./]+X[\d./]+X[\d./]+/,
  HSS: /HSS[\d./]+X[\d./]+X[\d./]+/
};

// Put the larger leg first so reversed angles (L3X4X1/4) match AISC (L4X3X1/4).
function normalizeAngleLegs(d) {
  return d.replace(/^(2?L)([\d.]+)X([\d.]+)X(.+)$/, function(_, pre, a, b, c) {
    const na = parseFloat(a), nb = parseFloat(b);
    return (na >= nb) ? (pre + a + 'X' + b + 'X' + c) : (pre + b + 'X' + a + 'X' + c);
  });
}

function extractDesignation(description, targetType) {
  const s = normalizeMixedFractions(normalizeSection(description));
  const pat = DESIG_PATTERNS[targetType];
  let d = '';
  if (pat) {
    const m = s.match(pat);
    if (m) d = m[0];
  }
  if (!d && targetType === 'HSS') {
    const m = s.match(/[\d./]+X[\d./]+X[\d./]+/);
    if (m) d = 'HSS' + m[0];
  }
  if (!d) d = s.split('-')[0]; // weak fallback; may not match AISC (gets flagged later)
  if (targetType === 'L' || targetType === '2L') d = normalizeAngleLegs(d);
  return d;
}

function parseExternalFromWorkbook(wb) {
  const result = {
    shapes: [], plates: [], misc: [], drawings: [], errors: [],
    skipped: { hardware: 0, stainless: 0, aluminum: 0, unrecognized: {} }
  };

  let shapePos = 0, platePos = 0, miscPos = 0;

  for (const sheet of externalTakeoffSheets(wb)) {
    const rates = readExternalRates(wb, sheet.name);

    sheet.eachRow((row, rowNum) => {
      if (rowNum <= 9) return;

      const colB        = cellString(row.getCell(2)).trim();   // drawing ref
      const colC        = cellString(row.getCell(3)).trim();   // section type
      const colD        = cellString(row.getCell(4)).trim();   // description
      const totalQty    = cellNumber(row.getCell(7));          // col G: total linear ft
      const totalWeight = cellNumber(row.getCell(10));         // col J: total lb w/ ~10%

      // Capture drawing references
      if (colB && !/^TOTAL\b/i.test(colB)) result.drawings.push(colB);

      if (!colC || !colD) return;
      const cu = colC.toUpperCase();
      if (isJunkSection(cu, colB)) return;

      // Hardware / stainless / aluminum: hold back, report, never silently drop.
      const held = heldKind(cu);
      if (held) { result.skipped[held] += 1; return; }

      const notesSuffix = colB ? ' | ' + colB : '';

      if (EXTERNAL_SHAPE_MAP[cu]) {
        // Shape bucket. l1 = linear feet; AISC lookup supplies weight/ft at calc
        // time. Uses raw footage so R&R applies their own waste factor.
        const sectionType = EXTERNAL_SHAPE_MAP[cu];
        const designation = extractDesignation(colD, sectionType);
        const rateKey     = RATE_LABEL_BY_TYPE[sectionType] || cu;
        shapePos += 1;
        if (!designation) {
          result.errors.push('Row ' + rowNum + ' (' + sheet.name + '): could not read a shape name from "' + colD + '"');
        }
        result.shapes.push({
          section_type: sectionType,
          position:     shapePos,
          section_name: designation,
          cost_factor:  rates[rateKey] || 0,
          drop_ft:      0,
          l1: totalQty, l2: 0, l3: 0, l4: 0, l5: 0, l6: 0, l7: 0, l8: 0,
          drawing: colB || '',
          notes: colD + notesSuffix
        });
      } else if (EXTERNAL_PLATE_TYPES.has(cu)) {
        if (totalWeight <= 0) return;
        platePos += 1;
        result.plates.push({
          position:    platePos,
          thickness:   '',
          cost_factor: rates['PLATE'] || 0,
          width_in:    0, length_in: 0, qty: 1,
          weight_lb:   totalWeight,
          notes:       '[' + colC + '] ' + colD + notesSuffix
        });
      } else if (EXTERNAL_MISC_TYPES.has(cu)) {
        if (totalWeight <= 0) return;
        miscPos += 1;
        result.misc.push({
          position:       miscPos,
          description:    '[' + colC + '] ' + colD + notesSuffix,
          qty:            1,
          weight_each_lb: totalWeight,
          cost_per_cwt:   rates[cu] || 0,
          notes:          ''
        });
      } else {
        // Unknown carbon item with a real weight: bring it in to Misc anyway so
        // nothing is lost, and record the label so we can add it as a known type.
        if (totalWeight > 0) {
          miscPos += 1;
          result.misc.push({
            position:       miscPos,
            description:    '[' + colC + '] ' + colD + notesSuffix,
            qty:            1,
            weight_each_lb: totalWeight,
            cost_per_cwt:   rates[cu] || 0,
            notes:          ''
          });
        }
        result.skipped.unrecognized[colC] = (result.skipped.unrecognized[colC] || 0) + 1;
      }
    });
  }

  if (shapePos + platePos + miscPos === 0) {
    result.errors.push('No steel items with weight found in the takeoff sheet(s)');
  }

  return result;
}
// --- End External Estimator Format Parser ---

// Parse the R&R Bid Takeoff Template.
// Supports both the legacy 3-tab format (Instructions / Shapes / Plates)
// and the new per-category multi-tab format (W Beams & Columns, HSS Tube, etc.).
// Also auto-detects the outsourced-estimator single- or multi-sheet format.
// Throw a user-friendly error for files we cannot read as a takeoff.
function unreadableFile(detail) {
  const err = new Error(detail);
  err.code = 'UNREADABLE_TAKEOFF_FILE';
  err.userMessage =
    "I couldn't read that as a takeoff. Upload an Excel (.xlsx) or CSV (.csv) " +
    "file with takeoff rows. " + (detail || '');
  return err;
}

// .xlsx files are ZIP archives that begin with the bytes "PK". Anything else
// (PDF, image, plain text like an eTakeoff .mhctl launcher) is not a workbook.
function looksLikeXlsx(buffer) {
  return buffer && buffer.length > 1 && buffer[0] === 0x50 && buffer[1] === 0x4b;
}

// Load a CSV buffer into a single-worksheet workbook so it can run through the
// same shape parser. ExcelJS reads CSV from a stream.
async function loadCsvWorkbook(buffer) {
  const { Readable } = require('stream');
  const wb = new ExcelJS.Workbook();
  const stream = Readable.from(buffer.toString('utf8'));
  await wb.csv.read(stream);
  return wb;
}

async function parseTemplate(buffer, filename = '') {
  const isCsv = /\.csv$/i.test(filename) || /\.tsv$/i.test(filename);

  // CSV path: read as one sheet of shape rows, auto-detecting the section type.
  if (isCsv) {
    let csvWb;
    try {
      csvWb = await loadCsvWorkbook(buffer);
    } catch (e) {
      throw unreadableFile('The CSV could not be parsed (' + e.message + ').');
    }
    const sheet = csvWb.worksheets[0];
    if (!sheet || sheet.rowCount < 2) {
      throw unreadableFile('The CSV had no data rows.');
    }
    const result = { shapes: [], plates: [], misc: [], errors: [] };
    const r = parseShapeSheet(sheet, null, result.errors, 0);
    result.shapes.push(...r.rows);
    return result;
  }

  // Non-CSV must be a real .xlsx (ZIP) workbook. Reject everything else cleanly
  // instead of letting ExcelJS throw an opaque error.
  if (!looksLikeXlsx(buffer)) {
    throw unreadableFile('That file is not an Excel workbook or CSV.');
  }

  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer);
  } catch (e) {
    throw unreadableFile('The Excel file appears to be corrupt or unsupported.');
  }

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
