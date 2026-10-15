-- Company wage rates: one set of burden rates, kept in Settings, copied into
-- every new estimate when it is created.
-- Only adds new things. No existing bid, wage row or setting is changed:
-- the new wage_rates columns start empty on every existing row, and existing
-- estimates keep exactly the rates they have.

-- Every save in Settings is kept as its own version, so an estimate can show
-- which company rates it started from and the history is never lost.
-- rows_json holds the five full roles (shop_worker, ironworker, firewatch,
-- laborer, pm). Half roles are derived from them when copied to an estimate.
CREATE TABLE IF NOT EXISTS company_wage_versions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  rows_json      TEXT NOT NULL,
  saved_by       INTEGER,
  saved_by_name  TEXT,
  saved_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Workers comp split into the numbers on the policy. When wc_base_pct is set,
-- wc_pct is calculated as wc_base_pct x wc_mod (mod defaults to 1). When it is
-- empty, as on every existing estimate, wc_pct is used exactly as entered.
ALTER TABLE wage_rates ADD COLUMN wc_base_pct REAL;
ALTER TABLE wage_rates ADD COLUMN wc_mod REAL;
ALTER TABLE wage_rates ADD COLUMN wc_class TEXT;

-- Which company rates version this row was copied from. Empty on every
-- existing estimate. A clone copies it along with the rest of the row.
ALTER TABLE wage_rates ADD COLUMN company_version_id INTEGER;
