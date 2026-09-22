'use strict';
// Comparing company names that people typed.
//
// "WM Schlosser", "W.M. Schlosser" and "WM  Schlosser," are one company. Everything
// here compares names with the punctuation removed entirely, not turned into spaces:
// "W.M." has to become "wm", not "w m", or it still will not meet "WM". Getting that
// wrong created a duplicate W.M. Schlosser in the CRM on 2026-09-18.
//
// Two variants per name, because an ampersand is written both ways: "B&B" is "bandb"
// to some people and "bb" to others. A match on either counts.
//
// This is the same rule the CRM uses in backend/companyNames.js. The two copies have
// to agree, or a spelling the CRM treats as a duplicate would group separately here.
function tight(s) {
  const base = String(s || '').toLowerCase();
  return [
    base.replace(/&/g, 'and').replace(/[^a-z0-9]/g, ''),
    base.replace(/&/g, '').replace(/[^a-z0-9]/g, ''),
  ].filter(Boolean);
}

// Do any spelling of a meet any spelling of b, under `how`?
function anyPair(a, b, how) {
  for (const x of tight(a)) for (const y of tight(b)) if (how(x, y)) return true;
  return false;
}

const sameName = (a, b) => anyPair(a, b, (x, y) => x === y);

// One stable key per typed name, so "Scott long" and "Scott Long" land in the same
// bucket. The first variant is enough: it is deterministic and only used to group.
function groupKey(s) {
  return tight(s)[0] || '';
}

module.exports = { tight, anyPair, sameName, groupKey };
