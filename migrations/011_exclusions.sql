-- Standard exclusions: shared list, shown on every proposal (can be toggled active/inactive)
CREATE TABLE IF NOT EXISTS standard_exclusions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL DEFAULT '',
  position REAL NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Site-specific exclusions: per-estimate, blank by default
CREATE TABLE IF NOT EXISTS estimate_site_exclusions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  estimate_id INTEGER NOT NULL REFERENCES estimates(id) ON DELETE CASCADE,
  text TEXT NOT NULL DEFAULT '',
  position REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_site_exclusions_estimate ON estimate_site_exclusions(estimate_id);
