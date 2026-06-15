-- Manual proposal lines + per-line hide/keep state for the client proposal.
-- Additive only. With no rows in either table, every line is visible and the
-- total is unchanged, so existing estimates behave exactly as before.
--
-- These tables are keyed by estimate_id. Alternates are their own estimate
-- rows, so they get their own manual lines and hide state automatically.

-- Manually added proposal lines (description + a dollar amount the user types).
-- The amount is a final pre-tax line figure; sales tax applies to it like any
-- other line. hidden = 1 drops it from the printed PDF/SOV. keep_in_total is
-- only meaningful when hidden: 1 = its dollars stay in the total, 0 = excluded,
-- NULL = the user has not chosen yet (blocks PDF download).
CREATE TABLE IF NOT EXISTS proposal_manual_lines (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  estimate_id   INTEGER NOT NULL REFERENCES estimates(id) ON DELETE CASCADE,
  position      REAL    NOT NULL DEFAULT 0,
  description   TEXT    NOT NULL DEFAULT '',
  amount        REAL    NOT NULL DEFAULT 0,
  hidden        INTEGER NOT NULL DEFAULT 0,
  keep_in_total INTEGER DEFAULT NULL
);
CREATE INDEX IF NOT EXISTS idx_manual_lines_estimate ON proposal_manual_lines(estimate_id);

-- Hide/keep state for the built-in calc-driven lines and Cost Inputs extras.
-- line_key identifies the line: 'core:1'..'core:7', 'po:1' (process-only lump
-- sum), 'sub:joist', 'sub:erection', or 'extra:<extraId>'. A missing row means
-- visible and fully counted (the default). keep_in_total semantics match above.
CREATE TABLE IF NOT EXISTS proposal_line_visibility (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  estimate_id   INTEGER NOT NULL REFERENCES estimates(id) ON DELETE CASCADE,
  line_key      TEXT    NOT NULL,
  hidden        INTEGER NOT NULL DEFAULT 0,
  keep_in_total INTEGER DEFAULT NULL,
  UNIQUE(estimate_id, line_key)
);
CREATE INDEX IF NOT EXISTS idx_line_vis_estimate ON proposal_line_visibility(estimate_id);
