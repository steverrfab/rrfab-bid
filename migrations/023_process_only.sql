-- Process Only / Fabrication-only estimating mode.
-- Additive only. Existing estimates default to job_type 'full' so the current
-- full-job flow is completely unchanged.

-- Job type discriminator: 'full' (existing behavior) or 'process_only'
ALTER TABLE estimates ADD COLUMN job_type TEXT DEFAULT 'full';

-- Process-only rate assumptions + summary settings (ignored for full jobs)
ALTER TABLE estimates ADD COLUMN po_labor_rate REAL DEFAULT 85;
ALTER TABLE estimates ADD COLUMN po_cost_rate REAL DEFAULT 35;
ALTER TABLE estimates ADD COLUMN po_beam_fab_rate REAL DEFAULT 140;
ALTER TABLE estimates ADD COLUMN po_process_rate REAL DEFAULT 185;
ALTER TABLE estimates ADD COLUMN po_galv_rate REAL DEFAULT 0.65;
ALTER TABLE estimates ADD COLUMN po_trucking_rate REAL DEFAULT 2500;
ALTER TABLE estimates ADD COLUMN po_plate_rate REAL DEFAULT 0.05;
ALTER TABLE estimates ADD COLUMN po_consumables_rate REAL DEFAULT 0.05;
ALTER TABLE estimates ADD COLUMN po_op_pct REAL DEFAULT 0.15;
ALTER TABLE estimates ADD COLUMN po_tax_pct REAL DEFAULT 0.06;

-- Process-only line items (one row per material line)
CREATE TABLE IF NOT EXISTS process_only_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  estimate_id INTEGER NOT NULL,
  position INTEGER DEFAULT 0,
  name TEXT DEFAULT '',
  line_type TEXT DEFAULT '',
  qty REAL DEFAULT 0,
  labor_hrs REAL DEFAULT 0,
  weight_lb REAL DEFAULT 0,
  galv_on INTEGER DEFAULT 0,
  proc_manual REAL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_po_lines_estimate ON process_only_lines (estimate_id);

-- Process-only additional costs (Plate Processing, Trucking, Galvanize, etc.)
CREATE TABLE IF NOT EXISTS process_only_addcosts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  estimate_id INTEGER NOT NULL,
  position INTEGER DEFAULT 0,
  name TEXT DEFAULT '',
  unit TEXT DEFAULT '',
  input_qty REAL DEFAULT 0,
  rate REAL DEFAULT 0,
  is_flat INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_po_addcosts_estimate ON process_only_addcosts (estimate_id);
