-- QuickBooks overhead check for Settings > Company Wage Rates.
-- Reference only. Only adds new tables. No estimate, wage row, saved company
-- rate or rate driver is changed, and nothing in quoting reads these tables.

-- Each press of "Pull from QuickBooks" is kept as its own snapshot.
-- accounts_json holds every expense line on the Profit and Loss for the period:
-- QuickBooks account id, name, which P&L section it sits in, and the amount.
-- labor_hours is typed in by hand for the same period (direct hours worked),
-- so overhead per hour can be worked out.
CREATE TABLE IF NOT EXISTS qbo_overhead_snapshots (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  pulled_at      TEXT NOT NULL DEFAULT (datetime('now')),
  pulled_by      INTEGER,
  pulled_by_name TEXT,
  period_start   TEXT NOT NULL,
  period_end     TEXT NOT NULL,
  basis          TEXT,
  sandbox        INTEGER NOT NULL DEFAULT 0,
  accounts_json  TEXT NOT NULL,
  labor_hours    REAL,
  note           TEXT
);

-- Which QuickBooks accounts count as overhead. Set once, kept across pulls,
-- keyed on the QuickBooks account id so a renamed account keeps its tick.
CREATE TABLE IF NOT EXISTS qbo_overhead_accounts (
  account_id   TEXT PRIMARY KEY,
  account_name TEXT,
  included     INTEGER NOT NULL DEFAULT 0,
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
