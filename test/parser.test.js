'use strict';
// Tests for the external-estimator workbook parser: shape roll-up by section,
// 5-slots-per-row continuation, plate dimension parsing / roll-up, and the
// invariant that imported linear footage matches the source workbook exactly.
// Run with: node test/parser.test.js

const assert = require('assert');
const ExcelJS = require('exceljs');
const { parseTemplate } = require('../lib/parser');
const calc = require('../lib/calc');

let passed = 0;
function approx(a, b, msg) {
  assert.ok(Math.abs(a - b) < 1e-6, (msg || '') + ' expected ' + b + ' got ' + a);
}

// Build a workbook in the external-estimator layout: row 9 header with col C =
// "Section", data from row 10. Columns used by the parser:
//   B(2)=drawing  C(3)=section  D(4)=description  E(5)=piece len(ft)
//   F(6)=piece count  G(7)=total ft  J(10)=weight lb
// `lines` is an array of [drawing, section, description, lenFt, count, weight?].
// total ft (col G) is filled as lenFt * count so the source's own footage total
// is unambiguous.
async function buildWorkbook(lines) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Takeoff - A');
  ws.getRow(9).getCell(3).value = 'Section';
  let r = 10;
  for (const [drawing, section, desc, lenFt, count, weight] of lines) {
    const row = ws.getRow(r++);
    row.getCell(2).value = drawing;
    row.getCell(3).value = section;
    row.getCell(4).value = desc;
    if (lenFt != null) row.getCell(5).value = lenFt;
    if (count != null) row.getCell(6).value = count;
    row.getCell(7).value = (lenFt != null && count != null) ? lenFt * count : (lenFt || 0);
    if (weight != null) row.getCell(10).value = weight;
  }
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

function shapeFootage(row) {
  let ft = 0;
  for (let i = 1; i <= 8; i++) {
    const l = +row['l' + i] || 0;
    const q = +row['q' + i] || 0;
    if (l > 0) ft += l * (q > 0 ? q : 1);
  }
  return ft;
}

async function run() {
  // ---- Shape roll-up + footage invariant ----
  {
    const lines = [
      // Two W12X26 lines at different lengths, plus a repeat of the 20-footer.
      ['S-101', 'WF', 'W12X26', 20, 3, 0],
      ['S-102', 'WF', 'W12X26', 30, 2, 0],
      ['S-103', 'WF', 'W12X26', 20, 1, 0],   // same length as line 1 -> merges, count sums to 4
      // An angle in its own section.
      ['S-201', 'ANGLE', 'L4X4X1/4', 12, 5, 0],
    ];
    const buf = await buildWorkbook(lines);
    const parsed = await parseTemplate(buf, 'takeoff.xlsx');

    const sourceFt = lines.reduce((s, l) => s + l[3] * l[4], 0);
    const importedFt = parsed.shapes.reduce((s, row) => s + shapeFootage(row), 0);
    approx(importedFt, sourceFt, 'imported linear footage matches source exactly');
    passed++; console.log('  ok - imported linear footage matches the source workbook exactly');

    const w = parsed.shapes.filter(r => r.section_name === 'W12X26');
    assert.strictEqual(w.length, 1, 'one rolled-up W12X26 row (2 distinct lengths -> fits in 5 slots)');
    // Distinct lengths 20 and 30; the two 20-footers merged to q = 4.
    approx(w[0].l1, 20); assert.strictEqual(w[0].q1, 4, '20-ft pieces summed to 4');
    approx(w[0].l2, 30); assert.strictEqual(w[0].q2, 2);
    passed++; console.log('  ok - identical piece lengths merge and sum their counts');

    // Drawing field lists only the drawings for the lengths on that row.
    assert.ok(w[0].drawing.includes('S-101') && w[0].drawing.includes('S-102') && w[0].drawing.includes('S-103'),
      'W12X26 row drawing lists its contributing drawings');
    passed++; console.log('  ok - row drawing lists the drawings for its lengths');
  }

  // ---- Continuation rows: >5 distinct lengths spill to a second row ----
  {
    const lens = [10, 11, 12, 13, 14, 15, 16]; // 7 distinct lengths -> 2 rows (5 + 2)
    const lines = lens.map((L, i) => ['D-' + i, 'WF', 'W10X22', L, i + 1, 0]);
    const buf = await buildWorkbook(lines);
    const parsed = await parseTemplate(buf, 'takeoff.xlsx');
    const rows = parsed.shapes.filter(r => r.section_name === 'W10X22');
    assert.strictEqual(rows.length, 2, 'spills onto a continuation row');
    assert.strictEqual(rows[0].notes, '', 'first row has no cont note');
    assert.strictEqual(rows[1].notes, 'cont. 2 of 2', 'continuation row tagged cont. 2 of 2');
    // First row holds 5 slots, second holds the remaining 2.
    assert.strictEqual([1,2,3,4,5].filter(i => rows[0]['l'+i] > 0).length, 5);
    assert.strictEqual([1,2,3,4,5].filter(i => rows[1]['l'+i] > 0).length, 2);
    const total = rows.reduce((s, r) => s + shapeFootage(r), 0);
    approx(total, lens.reduce((s, L, i) => s + L * (i + 1), 0), 'footage preserved across continuation rows');
    passed++; console.log('  ok - >5 distinct lengths continue on a row tagged cont. N of M');
  }

  // ---- Plate dimension parsing + roll-up ----
  {
    const lines = [
      // Straight plate: thickness 1/2, width 4-1/2; length from col E (2 ft -> 24 in).
      ['P-1', 'PLATE', 'PL 1/2 x 4-1/2 x 15', 2, 3, 999],
      // Identical plate again -> rolls up, qty sums to 5.
      ['P-2', 'PLATE', 'PL 1/2 x 4-1/2 x 15', 2, 2, 999],
      // Bent plate: developed width = 3 + 4 = 7.
      ['P-3', 'BENT PLATE', 'PL 1/4 x 3 x 4', 1, 1, 999],
      // No readable dimensions: falls back to the estimator weight (col J).
      ['P-4', 'PLATE', 'MISC PLATE ASSY', null, null, 1234],
    ];
    const buf = await buildWorkbook(lines);
    const parsed = await parseTemplate(buf, 'takeoff.xlsx');

    const straight = parsed.plates.find(p => p.thickness === '1/2');
    assert.ok(straight, 'straight plate parsed');
    approx(straight.width_in, 4.5, 'width 4-1/2 in');
    approx(straight.length_in, 24, 'length_in = col E(2 ft) x 12');
    assert.strictEqual(straight.qty, 5, 'identical plates rolled up: 3 + 2');
    passed++; console.log('  ok - plate thickness/width parsed, length from col E, identical plates roll up');

    const bent = parsed.plates.find(p => p.thickness === '1/4');
    assert.ok(bent, 'bent plate parsed');
    approx(bent.width_in, 7, 'bent developed width = legs summed (3 + 4)');
    approx(bent.length_in, 12, 'bent length_in = col E(1 ft) x 12');
    passed++; console.log('  ok - bent plate width is the two legs summed');

    const fallback = parsed.plates.find(p => (p.weight_lb || 0) === 1234);
    assert.ok(fallback, 'unparseable plate fell back to estimator weight');
    assert.strictEqual(fallback.thickness, '', 'fallback plate has no thickness');
    passed++; console.log('  ok - plate with no readable dimensions falls back to col J weight');
  }

  // Real-world plate descriptions, copied verbatim from an estimator workbook.
  // The PL prefix runs straight into the thickness and every dimension carries
  // an inch mark. Both used to defeat the dimension split: the thickness token
  // failed to parse, was dropped, and the WIDTH became the thickness, so a
  // 1-1/4" base plate imported as a 20" plate. With '3/8"' the inch mark also
  // made the weight table miss and read it as 3 inches thick. Between them the
  // plate section on a real bid came out at 203,457 lb instead of 13,090.
  {
    const lines = [
      ['P-1', 'PLATE', 'PL1-1/4"x20"x20" - Base Plate',            1.67, 8],
      ['P-2', 'PLATE', 'PL3/8"x4-1/2"x9" - Shear Plate',           0.75, 10],
      ['P-3', 'PLATE', 'PL1/2"X8" - Cont. Plate',                  22.75, 1],
      ['P-4', 'PLATE', 'PL5/16"X4-1/2X5-1/2" - Cont. Bent Plate',  22.75, 1],
    ];
    const buf = await buildWorkbook(lines);
    const parsed = await parseTemplate(buf, 'takeoff.xlsx');

    // Stored as "1 1/4", the spelling PLATE_PSF uses, so the weight lookup hits
    // the table instead of falling through to parseFloat and reading one inch.
    const base = parsed.plates.find(p => p.thickness === '1 1/4');
    assert.ok(base, 'PL prefix stripped: thickness is 1 1/4, not the 20 in width');
    approx(base.width_in, 20, 'width 20 in');
    approx(calc.plateUnitWeight(base.thickness), 1.25 / 12 * 490, 'and it resolves off the plate table');
    passed++; console.log('  ok - "PL1-1/4\\"x20\\"x20\\"" reads thickness 1 1/4, width 20');

    const shear = parsed.plates.find(p => p.thickness === '3/8');
    assert.ok(shear, 'inch marks stripped: thickness is 3/8, not 3/8"');
    approx(shear.width_in, 4.5, 'width 4-1/2 in survives the inch mark');
    passed++; console.log('  ok - inch marks do not leak into the thickness');

    const cont = parsed.plates.find(p => p.thickness === '1/2');
    assert.ok(cont, 'two-dimension description still parses');
    approx(cont.width_in, 8, 'width 8 in');
    passed++; console.log('  ok - a thickness x width description still parses');

    const bent = parsed.plates.find(p => p.thickness === '5/16');
    assert.ok(bent, 'bent plate thickness parsed');
    approx(bent.width_in, 10, 'bent developed width = 4-1/2 + 5-1/2, not 4.5 + 5');
    passed++; console.log('  ok - trailing prose does not truncate the last bent leg');
  }

  console.log('\nAll ' + passed + ' parser tests passed.');
}

run().catch(err => { console.error(err); process.exit(1); });
