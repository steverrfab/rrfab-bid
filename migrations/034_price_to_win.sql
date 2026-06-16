-- Price-to-win override, cost-aware margin, and an editable client breakdown.
-- Additive only. With price_to_win NULL, no manual-line cost, and no client-line
-- overrides, every estimate behaves exactly as before: the proposal total stays
-- the computed lines total and margin stays the cost-plus number.

-- The final price you choose to quote ("price to win"). NULL means use the
-- computed lines total (cost-plus, after any hide/manual edits). When set, this
-- is the bid total and margin = price_to_win minus your included cost.
ALTER TABLE estimates ADD COLUMN price_to_win REAL DEFAULT NULL;

-- Snapshot of the price marked "this is the client quote" via Set as client
-- quote. NULL means not set; the quote defaults to whatever the price shows.
ALTER TABLE estimates ADD COLUMN client_quote_amount REAL DEFAULT NULL;

-- Internal cost for a manual proposal line (never printed to the client).
-- 0 = pure margin. Lets margin reflect manual lines that carry real cost.
ALTER TABLE proposal_manual_lines ADD COLUMN cost REAL NOT NULL DEFAULT 0;

-- Editable client-facing breakdown. The client proposal can be itemized however
-- the user wants; a row here overrides the displayed description and/or amount
-- for one line_key (core:N, sub:joist, sub:erection, extra:<id>, manual:<id>,
-- po:1). No rows = the breakdown is the computed/scaled default. Presentation
-- only: these never affect cost, margin, or the dashboard.
CREATE TABLE IF NOT EXISTS proposal_client_lines (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  estimate_id INTEGER NOT NULL REFERENCES estimates(id) ON DELETE CASCADE,
  line_key    TEXT    NOT NULL,
  description TEXT    DEFAULT NULL,
  amount      REAL    DEFAULT NULL,
  UNIQUE(estimate_id, line_key)
);
CREATE INDEX IF NOT EXISTS idx_client_lines_estimate ON proposal_client_lines(estimate_id);
