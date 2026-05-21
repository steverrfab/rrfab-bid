-- R&R Bid - misc metals takeoff + notification recipients + settings KV
-- Safe to run multiple times.

-- Takeoff line items for misc metals (stairs, handrails, brackets, embeds, etc.)
CREATE TABLE IF NOT EXISTS takeoff_misc (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  estimate_id INTEGER NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  description TEXT DEFAULT '',
  qty REAL DEFAULT 0,
  weight_each_lb REAL DEFAULT 0,
  cost_per_cwt REAL DEFAULT 0,
  notes TEXT DEFAULT '',
  FOREIGN KEY (estimate_id) REFERENCES estimates(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_misc_estimate ON takeoff_misc(estimate_id, position);

-- People who get the "ready to submit" email
CREATE TABLE IF NOT EXISTS notification_recipients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  name TEXT DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (email)
);

-- Generic settings KV for things like submission email template overrides
CREATE TABLE IF NOT EXISTS settings_kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
