'use strict';

// Tekla Structures KISS (.kss) parser for process-only material import.
// D line fields: D, asmMark, _, mark, pieceMark, qty, shapeType, size, grade, length_mm, _, CATEGORY
// Returns a flat list of pieces. Shape/Size and Mark are kept SEPARATE; the
// shape/size string is what becomes the line description.

const MM_PER_FT = 304.8;
const PLATE_PSF = {
  '3/16': 0.1875 / 12 * 490, '1/4': 0.25 / 12 * 490, '5/16': 0.3125 / 12 * 490,
  '3/8': 0.375 / 12 * 490, '7/16': 0.4375 / 12 * 490, '1/2': 0.5 / 12 * 490,
  '5/8': 0.625 / 12 * 490, '3/4': 0.75 / 12 * 490, '7/8': 0.875 / 12 * 490, '1': 1 / 12 * 490
};
function platePsf(t) {
  if (PLATE_PSF[t] != null) return PLATE_PSF[t];
  const d = parseFloat(t);
  return Number.isFinite(d) ? d / 12 * 490 : 0;
}
function num(v) { const x = parseFloat(String(v).replace(/[$,]/g, '')); return Number.isFinite(x) ? x : 0; }

// aiscLookup(label) -> weight per foot (0 if not found). Same fn the routes use.
function pieceWeight(shapeType, size, lenMm, qty, aiscLookup) {
  const lenFt = num(lenMm) / MM_PER_FT, q = num(qty);
  if (shapeType === 'HS') return 0; // bolts
  if (shapeType === 'FL' || shapeType === 'PL') {
    const m = String(size).match(/^([0-9/\-. ]+)X([0-9/.]+)/i);
    if (!m) return 0;
    return platePsf(m[1].trim()) * ((parseFloat(m[2]) || 0) / 12) * lenFt * q;
  }
  return (aiscLookup ? aiscLookup(shapeType + size) : 0) * lenFt * q;
}

function parseKiss(text, aiscLookup) {
  const lines = String(text).split(/\r?\n/);
  const pieces = [];
  for (const line of lines) {
    const f = line.split(',');
    if (f[0] !== 'D' || f.length < 12) continue;
    const qty = num(f[5]);
    const shapeType = (f[6] || '').trim();
    const size = (f[7] || '').trim();
    const shape = (shapeType + ' ' + size).trim();
    if (!shape) continue;
    const mark = (f[4] || f[3] || f[1] || '').trim();
    const category = (f[11] || '').trim();
    const lenMm = num(f[9]);
    const wt = Math.round(pieceWeight(shapeType, size, lenMm, qty, aiscLookup));
    pieces.push({ mark, shape, category, qty, weight: wt });
  }
  return pieces;
}

// Convert a Tekla KISS (.kss) file into the same { shapes, plates, misc, errors }
// shape that parseTemplate returns, so a KISS file can feed the Takeoff tab.
// Structural pieces -> shapes (total linear ft in l1); PL/FL -> plates;
// HS (bolts/hardware) are held back and reported, never silently dropped.
function parseKissToTakeoff(text) {
  const { detectSectionType } = require('./calc');
  const lines = String(text).split(/\r?\n/);
  const result = { shapes: [], plates: [], misc: [], errors: [] };
  let sPos = 0, pPos = 0, skippedBolts = 0;
  for (const line of lines) {
    const f = line.split(',');
    if (f[0] !== 'D' || f.length < 12) continue;
    const qty = num(f[5]) || 1;
    const shapeType = (f[6] || '').trim();
    const size = (f[7] || '').trim();
    if (!shapeType && !size) continue;
    const mark = (f[4] || f[3] || f[1] || '').trim();
    const lenFt = num(f[9]) / MM_PER_FT;
    const label = (shapeType + size).trim();
    const noteMark = mark ? ('Mark ' + mark) : '';

    if (shapeType === 'HS') { skippedBolts += qty; continue; }

    if (shapeType === 'PL' || shapeType === 'FL') {
      const m = String(size).match(/^([0-9/\-. ]+)X([0-9/.]+)/i);
      if (!m) { result.errors.push('KISS plate "' + size + '" (' + noteMark + ') could not be read.'); continue; }
      pPos += 1;
      result.plates.push({
        position: pPos,
        thickness: m[1].trim(),
        cost_factor: 0,
        width_in: parseFloat(m[2]) || 0,
        length_in: Math.round(lenFt * 12 * 100) / 100,
        qty,
        weight_lb: 0,
        notes: noteMark
      });
      continue;
    }

    const sectionType = detectSectionType(label);
    sPos += 1;
    if (!sectionType) {
      result.errors.push('KISS piece ' + (mark || label) + ': unrecognized shape "' + label + '" (add a manual weight).');
    }
    result.shapes.push({
      section_type: sectionType || '',
      position: sPos,
      section_name: label,
      cost_factor: 0,
      drop_ft: 0,
      l1: Math.round(lenFt * qty * 100) / 100,
      l2: 0, l3: 0, l4: 0, l5: 0, l6: 0, l7: 0, l8: 0,
      drawing: '',
      notes: noteMark
    });
  }
  if (skippedBolts) result.errors.push(skippedBolts + ' bolt/hardware piece(s) skipped (not part of the material takeoff).');
  return result;
}

module.exports = { parseKiss, parseKissToTakeoff };
