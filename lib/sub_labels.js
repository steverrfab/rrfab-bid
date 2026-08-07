'use strict';

// The two subcontractor lines carry a per-estimate description override
// (estimates.sub_joist_deck_label / sub_erection_label, added in migration 054).
// An estimator pricing joist but excluding deck needs the line to say so on the
// proposal, the PDF and the SOV.
//
// NULL, empty, or whitespace means "use the built-in wording". Every estimate
// that existed before 054 is NULL, so it keeps printing exactly what it printed
// before. Kept in its own module with no dependencies so the proposal builder,
// the PDF writer and the SOV routes can all share one definition of the rule
// rather than each re-implementing it and drifting apart.
function subLabel(override, fallback) {
  const s = (override == null ? '' : String(override)).trim();
  return s || fallback;
}

module.exports = { subLabel };
