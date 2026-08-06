'use strict';
// Unit tests for lib/calc computeShapeRow, focused on the per-piece length x
// quantity model and its backward compatibility with legacy count-less rows.
// Run with: node test/calc.test.js

const assert = require('assert');
const calc = require('../lib/calc');

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log('  ok - ' + name);
}
function approx(a, b, msg) {
  assert.ok(Math.abs(a - b) < 1e-9, (msg || '') + ' expected ' + b + ' got ' + a);
}

// The old model (before q1..q8 existed) for reference: totalLength = sum of the
// filled lengths, drop applied once per filled slot.
function legacyExpectation(row, wpf) {
  const lengths = [row.l1, row.l2, row.l3, row.l4, row.l5, row.l6, row.l7, row.l8].map(v => +v || 0);
  const totalLength = lengths.reduce((a, b) => a + b, 0);
  const filled = lengths.filter(x => x > 0).length;
  const dropTotal = (+row.drop_ft || 0) * filled;
  const totalWeight = wpf * (totalLength + dropTotal);
  return { totalLength, totalWeight, pieces: filled };
}

console.log('computeShapeRow:');

test('legacy row with no counts prices identically to the old model', () => {
  const row = { l1: 20, l2: 30, l3: 0, l4: 0, l5: 0, l6: 0, l7: 0, l8: 0, drop_ft: 2, cost_factor: 50 };
  const wpf = 26.0;
  const got = calc.computeShapeRow(row, wpf);
  const exp = legacyExpectation(row, wpf);
  approx(got.totalLength, exp.totalLength, 'totalLength');
  approx(got.totalWeight, exp.totalWeight, 'totalWeight');
  assert.strictEqual(got.pieces, exp.pieces, 'pieces = number of filled slots');
  approx(got.totalLength, 50, 'totalLength value');
  approx(got.pieces, 2, 'pieces value');       // 2 filled slots -> 2 pieces
});

test('legacy row: q columns entirely absent still counts each slot as one piece', () => {
  const row = { l1: 15, l2: 15, l3: 15, drop_ft: 1, cost_factor: 0 }; // no q* keys at all
  const wpf = 10;
  const got = calc.computeShapeRow(row, wpf);
  approx(got.totalLength, 45);
  assert.strictEqual(got.pieces, 3);
  approx(got.totalWeight, wpf * (45 + 1 * 3)); // drop once per piece (3)
});

test('a filled length with q = 0 is treated as a single piece', () => {
  const row = { l1: 20, q1: 0, drop_ft: 5, cost_factor: 0 };
  const got = calc.computeShapeRow(row, 10);
  approx(got.totalLength, 20);
  assert.strictEqual(got.pieces, 1);
  approx(got.totalWeight, 10 * (20 + 5 * 1));
});

test('per-piece counts multiply length and drive drop total', () => {
  const row = { l1: 20, q1: 3, l2: 30, q2: 2, drop_ft: 2, cost_factor: 100 };
  const wpf = 5;
  const got = calc.computeShapeRow(row, wpf);
  approx(got.totalLength, 20 * 3 + 30 * 2);     // 120
  assert.strictEqual(got.pieces, 5);            // 3 + 2
  approx(got.totalWeight, wpf * (120 + 2 * 5)); // drop 2 ft x 5 pieces
  approx(got.totalPrice, 100 * (wpf * (120 + 10)) / 100);
});

test('a count on an empty length slot contributes nothing', () => {
  const row = { l1: 0, q1: 9, l2: 10, q2: 2, drop_ft: 0, cost_factor: 0 };
  const got = calc.computeShapeRow(row, 4);
  approx(got.totalLength, 20);   // only l2 counts
  assert.strictEqual(got.pieces, 2);
});

test('takeoffTotals aggregates the new per-piece lengths by section', () => {
  const shapes = [
    { section_type: 'W', section_name: 'W12X26', cost_factor: 0, drop_ft: 0, l1: 20, q1: 3 },
  ];
  const aisc = (name) => (name === 'W12X26' ? 26 : 0);
  const totals = calc.takeoffTotals(shapes, [], [], aisc);
  approx(totals.W.length, 60);           // 20 ft x 3 pieces
  approx(totals.W.weight, 26 * 60);
});

console.log('\nAll ' + passed + ' computeShapeRow tests passed.');
