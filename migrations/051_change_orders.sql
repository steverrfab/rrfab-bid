-- Change Orders: two new tables. No existing table or column is altered.
-- estimate_id is nullable: a change order may stand alone, with its own
-- project_name / client_gc, and be attached to a bid later (see 056).
-- Statements are idempotent because db.js re-runs every migration on startup.
-- No triggers: the migration runner splits on ";" and would break on BEGIN...END.

CREATE TABLE IF NOT EXISTS change_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  estimate_id INTEGER REFERENCES estimates(id),
  parent_type TEXT NOT NULL DEFAULT 'standalone',
  project_name TEXT NOT NULL DEFAULT '',
  client_gc TEXT NOT NULL DEFAULT '',
  seq INTEGER NOT NULL DEFAULT 1,
  title TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  requested_by TEXT NOT NULL DEFAULT '',
  scope TEXT NOT NULL DEFAULT '',
  pricing_mode TEXT NOT NULL DEFAULT 'quick',
  status TEXT NOT NULL DEFAULT 'Draft',
  oh_rate REAL DEFAULT 0.05,
  contingency_rate REAL DEFAULT 0,
  profit_rate REAL DEFAULT 0.10,
  cgl_rate REAL DEFAULT 0,
  sales_tax_rate REAL DEFAULT 0.06,
  tax_mode TEXT DEFAULT 'full',
  created_by INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS change_order_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  change_order_id INTEGER NOT NULL REFERENCES change_orders(id),
  description TEXT NOT NULL DEFAULT '',
  qty REAL NOT NULL DEFAULT 0,
  unit TEXT NOT NULL DEFAULT 'ea',
  unit_cost REAL NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_change_orders_estimate ON change_orders(estimate_id);
CREATE INDEX IF NOT EXISTS idx_change_orders_status ON change_orders(status);
CREATE INDEX IF NOT EXISTS idx_change_order_lines_co ON change_order_lines(change_order_id);
