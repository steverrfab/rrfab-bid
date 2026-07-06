'use strict';

// Canonical normalization for AISC section labels so that different but
// equivalent spellings of the same section resolve to one another.
//
// The recurring support issue was that a section was physically in the weight
// table but a takeoff spelled it slightly differently and it looked "missing"
// (came up blank, priced at 0). Things this bridges:
//   1. Fractions vs decimals: "Pipe 1-1/2 STD", "Pipe 1 1/2 STD" and stored
//      "Pipe1.5STD" are the same pipe; likewise angle/HSS leg and wall fractions
//      (3/16 vs 0.1875, 3-1/2 vs 3.5).
//   2. Spacing and case: "W6 X 25", "w6x25", "W6X25".
//   3. Trailing-zero decimals: round HSS "HSS3.500X0.250" vs "HSS3.5X0.25".
//   4. Pipe strength spelling: extra-strong "X-STG" vs the AISC "XS", and
//      double-extra-strong "XX-STG" vs "XXS".
//
// It runs on BOTH sides of every comparison: the stored label (via the
// label_norm column, populated in db.js) and whatever the user typed. It never
// renames the stored label, so saved estimates and the won-jobs tracker feed
// are unaffected.
//
// Order matters: convert mixed numbers and fractions to decimals BEFORE
// stripping whitespace, otherwise "1 1/2" would collapse to the ambiguous
// "11/2" and be read as eleven-halves instead of one-and-a-half.
function normalizeLabel(input) {
  let s = String(input == null ? '' : input).toUpperCase();

  // Mixed number: "A B/C" or "A-B/C"  ->  decimal (e.g. 1-1/2 -> 1.5, 2 1/2 -> 2.5)
  s = s.replace(/(\d+)[\s-]+(\d+)\/(\d+)/g, (m, whole, num, den) => {
    const d = Number(den);
    if (!d) return m;
    return String(Number(whole) + Number(num) / d);
  });

  // Simple fraction: "B/C"  ->  decimal (e.g. 1/2 -> 0.5, 3/16 -> 0.1875)
  s = s.replace(/(\d+)\/(\d+)/g, (m, num, den) => {
    const d = Number(den);
    if (!d) return m;
    return String(Number(num) / d);
  });

  // Collapse decimal precision so trailing zeros do not matter
  // (3.500 -> 3.5, 5.000 -> 5, 0.250 -> 0.25). Only touches real decimals;
  // integers like the 200 in W40X200 have no dot and are left alone.
  s = s.replace(/\d+\.\d+/g, (m) => String(Number(m)));

  // Resolve fractions/decimals done; now remove all whitespace.
  s = s.replace(/\s+/g, '');

  // Pipe strength designations to a single canonical spelling. Order matters:
  // handle the double (XX) form before the single (X) form.
  s = s.replace(/XX-STG/g, 'XXS').replace(/X-STG/g, 'XS').replace(/STANDARD/g, 'STD');

  return s;
}

module.exports = { normalizeLabel };
