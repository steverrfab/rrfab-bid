-- R&R Bid - initial schema
-- All tables created if they don't exist. Safe to run multiple times.

CREATE TABLE IF NOT EXISTS estimates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  -- Project Info
  project_name TEXT DEFAULT '',
  job_number TEXT DEFAULT '',
  bid_number TEXT DEFAULT '',
  client_gc TEXT DEFAULT '',
  bid_date TEXT DEFAULT '',
  prepared_by TEXT DEFAULT '',
  scope TEXT DEFAULT '',
  status TEXT DEFAULT 'Draft',

  -- Section 2: Fab Labor
  fab_mh REAL DEFAULT 0,
  fab_rate REAL DEFAULT 75,
  processing_rate REAL DEFAULT 0.10,

  -- Section 3: Finishes
  paint_weight REAL DEFAULT 0,
  paint_rate REAL DEFAULT 0.06,
  consumables_weight REAL DEFAULT 0,
  consumables_rate REAL DEFAULT 0.02,
  handling_weight REAL DEFAULT 0,
  handling_rate REAL DEFAULT 0.02,
  galv_weight REAL DEFAULT 0,
  galv_rate REAL DEFAULT 0.65,

  -- Section 4: Detail/Freight/Erect
  struct_detailing REAL DEFAULT 0,
  misc_detailing REAL DEFAULT 0,
  pe_stamp REAL DEFAULT 0,
  freight REAL DEFAULT 0,
  erection_mh REAL DEFAULT 0,
  erection_rate REAL DEFAULT 0,
  erection_equip REAL DEFAULT 0,

  -- Section 5: Markup Cascade
  oh_rate REAL DEFAULT 0.05,
  contingency_rate REAL DEFAULT 0,
  profit_rate REAL DEFAULT 0.10,
  cgl_rate REAL DEFAULT 0,

  -- Section 6: Sales Tax
  sales_tax_rate REAL DEFAULT 0.06,
  tax_mode TEXT DEFAULT 'full', -- full | star | none

  -- Client Proposal text overrides
  proposal_to TEXT DEFAULT '',
  proposal_scope TEXT DEFAULT '',
  proposal_exclusions TEXT DEFAULT '',
  proposal_terms TEXT DEFAULT '',
  proposal_submitted_by TEXT DEFAULT '',

  -- Larger Job Bid inputs
  ljb_tons REAL DEFAULT 0,
  ljb_distance_miles REAL DEFAULT 0,
  ljb_galv_lbs REAL DEFAULT 0,
  ljb_aess_lbs REAL DEFAULT 0,
  ljb_aess_rate REAL DEFAULT 0.38,
  ljb_galv_rate REAL DEFAULT 0.65,
  ljb_joist_sub1 REAL DEFAULT 0,
  ljb_joist_sub2 REAL DEFAULT 0,
  ljb_erect_sub1 REAL DEFAULT 0,
  ljb_erect_sub2 REAL DEFAULT 0,
  ljb_op_rate REAL DEFAULT 0.15,
  ljb_shop_dwg_pages INTEGER DEFAULT 0,

  submitted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_estimates_status ON estimates(status);
CREATE INDEX IF NOT EXISTS idx_estimates_updated ON estimates(updated_at);

-- Material overrides: when user types weight directly in Cost Inputs.
-- If a row exists for (estimate_id, section), it overrides the takeoff for that section.
CREATE TABLE IF NOT EXISTS material_overrides (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  estimate_id INTEGER NOT NULL,
  section TEXT NOT NULL,
  weight_lb REAL,
  cost_per_cwt REAL,
  FOREIGN KEY (estimate_id) REFERENCES estimates(id) ON DELETE CASCADE,
  UNIQUE (estimate_id, section)
);

-- Takeoff shape rows (W, WT, HSS, C, MC, L, 2L, S, PIPE)
CREATE TABLE IF NOT EXISTS takeoff_shapes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  estimate_id INTEGER NOT NULL,
  section_type TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  section_name TEXT DEFAULT '',
  cost_factor REAL DEFAULT 0,
  drop_ft REAL DEFAULT 0,
  l1 REAL DEFAULT 0, l2 REAL DEFAULT 0, l3 REAL DEFAULT 0, l4 REAL DEFAULT 0,
  l5 REAL DEFAULT 0, l6 REAL DEFAULT 0, l7 REAL DEFAULT 0, l8 REAL DEFAULT 0,
  notes TEXT DEFAULT '',
  FOREIGN KEY (estimate_id) REFERENCES estimates(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_shapes_estimate ON takeoff_shapes(estimate_id, section_type, position);

CREATE TABLE IF NOT EXISTS takeoff_plates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  estimate_id INTEGER NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  thickness TEXT DEFAULT '',
  cost_factor REAL DEFAULT 0,
  width_in REAL DEFAULT 0,
  length_in REAL DEFAULT 0,
  qty REAL DEFAULT 0,
  notes TEXT DEFAULT '',
  FOREIGN KEY (estimate_id) REFERENCES estimates(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_plates_estimate ON takeoff_plates(estimate_id, position);

-- Wage rates per estimate per role
CREATE TABLE IF NOT EXISTS wage_rates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  estimate_id INTEGER NOT NULL,
  role TEXT NOT NULL,
  base_rate REAL DEFAULT 0,
  cash_in_lieu REAL DEFAULT 0,
  fica_pct REAL DEFAULT 0.0765,
  futa_pct REAL DEFAULT 0.006,
  suta_pct REAL DEFAULT 0.012,
  wc_pct REAL DEFAULT 0.07,
  gl_pct REAL DEFAULT 0.11,
  umbrella_pct REAL DEFAULT 0,
  auto_pct REAL DEFAULT 0,
  pp_bond_pct REAL DEFAULT 0,
  health_welfare REAL DEFAULT 0,
  pension REAL DEFAULT 0,
  consumables_pct REAL DEFAULT 0,
  fuel_pct REAL DEFAULT 0,
  ohp_pct REAL DEFAULT 0.10,
  FOREIGN KEY (estimate_id) REFERENCES estimates(id) ON DELETE CASCADE,
  UNIQUE (estimate_id, role)
);

-- AISC reference database (seeded once on startup)
CREATE TABLE IF NOT EXISTS aisc_sections (
  label TEXT PRIMARY KEY,
  t_f TEXT DEFAULT '',
  weight_per_ft REAL NOT NULL
);
