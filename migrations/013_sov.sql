CREATE TABLE IF NOT EXISTS sov_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  estimate_id INTEGER NOT NULL REFERENCES estimates(id) ON DELETE CASCADE,
  item_no TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  scheduled_value REAL NOT NULL DEFAULT 0,
  position REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sov_estimate ON sov_items(estimate_id);
