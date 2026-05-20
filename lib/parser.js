'use strict';
const ExcelJS = require('exceljs');
const { detectSectionType } = require('./calc');

// Normalize Unicode fractions to ASCII (per project convention).
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

// Parse the R&R Bid Takeoff Template (or similar Excel format).
// Returns { shapes: [...], plates: [...], errors: [...] }
async function parseTemplate(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);

  const result = { shapes: [], plates: [], errors: [] };

  // ---- Shapes sheet ----
  const shapesSheet = wb.getWorksheet('Shapes') || findSheet(wb, /shapes?/i);
  if (shapesSheet) {
    // Header row expected at row 1: Section, $/CWT, Drop, L1..L8, Notes
    let position = 0;
    shapesSheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      const section = normalizeSection(cellString(row.getCell(1)));
      if (!section) return;
      const type = detectSectionType(section);
      if (!type) {
        result.errors.push(`Row ${rowNumber}: unrecognized section name "${section}"`);
        return;
      }
      position += 1;
      result.shapes.push({
        section_type: type,
        position,
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
  } else {
    result.errors.push('No "Shapes" sheet found. Skipping shape rows.');
  }

  // ---- Plates sheet ----
  const platesSheet = wb.getWorksheet('Plates') || findSheet(wb, /plates?/i);
  if (platesSheet) {
    let position = 0;
    platesSheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      const thickness = normalizeThickness(cellString(row.getCell(1)));
      const qty = cellNumber(row.getCell(5));
      // skip blank lines
      if (!thickness && !qty) return;
      position += 1;
      result.plates.push({
        position,
        thickness,
        cost_factor: cellNumber(row.getCell(2)),
        width_in: cellNumber(row.getCell(3)),
        length_in: cellNumber(row.getCell(4)),
        qty,
        notes: cellString(row.getCell(6)).trim()
      });
    });
  }

  return result;
}

function findSheet(wb, pattern) {
  return wb.worksheets.find(s => pattern.test(s.name));
}

module.exports = { parseTemplate, normalizeSection, normalizeThickness };
