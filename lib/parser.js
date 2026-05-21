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

// Sheet-name to section_type hints. Lets users use clearly labeled per-category tabs.
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
  if (n === 'shapes' || n === 'allshapes') return null; // mixed - rely on prefix detection
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
    if (!type) {
      type = detectSectionType(section);
    }
    if (!type) {
      errors.push(`${sheet.name} row ${rowNumber}: unrecognized section "${section}"`);
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

// Parse the R&R Bid Takeoff Template.
// Supports both the legacy 3-tab format (Instructions / Shapes / Plates)
// and the new per-category multi-tab format (W Beams & Columns, HSS Tube, Misc Metals, etc.).
async function parseTemplate(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);

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
      // A specific shape category sheet
      const r = parseShapeSheet(sheet, hint, result.errors, shapePos);
      result.shapes.push(...r.rows);
      shapePos = r.lastPos;
    } else {
      // No hint - if name contains "shapes" or is a known generic sheet, parse with prefix detection
      const lname = name.toLowerCase();
      if (lname.includes('shape')) {
        const r = parseShapeSheet(sheet, null, result.errors, shapePos);
        result.shapes.push(...r.rows);
        shapePos = r.lastPos;
      }
      // else: ignore unknown sheets silently
    }
  }

  return result;
}

function findSheet(wb, pattern) {
  return wb.worksheets.find(s => pattern.test(s.name));
}

module.exports = { parseTemplate, normalizeSection, normalizeThickness };
