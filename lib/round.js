'use strict';

// Whole-dollar helpers. Bids are quoted in whole dollars, so any list of dollar
// figures shown to a client (SOV lines, proposal lines) must (a) carry no cents
// and (b) still add up to the same whole-dollar total it did before rounding.

// Round each entry's dollar figure (stored under `key`) to a whole dollar, then
// push the small rounding residual onto the largest non-zero entry so the column
// still foots to a whole-dollar total. `target` (optional) sets the total to foot
// to; by default it is the rounded sum of the inputs. Zero entries are untouched.
// Mutates and returns the same array.
function footToWholeDollars(items, key, target) {
  if (!Array.isArray(items) || items.length === 0) return items;
  const goal = (target == null)
    ? Math.round(items.reduce((s, it) => s + (+it[key] || 0), 0))
    : Math.round(+target || 0);
  let runningSum = 0;
  let largestIdx = -1;
  let largestVal = -Infinity;
  items.forEach((it, i) => {
    const rounded = Math.round(+it[key] || 0);
    it[key] = rounded;
    runningSum += rounded;
    if (rounded !== 0 && rounded > largestVal) { largestVal = rounded; largestIdx = i; }
  });
  if (largestIdx >= 0 && runningSum !== goal) {
    items[largestIdx][key] += (goal - runningSum);
  }
  return items;
}

// SOV convenience wrapper: foot each line's scheduled_value to the column total.
function footSovItems(items) { return footToWholeDollars(items, 'scheduled_value'); }

module.exports = { footToWholeDollars, footSovItems };
