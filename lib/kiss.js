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

module.exports = { parseKiss };
