CREATE TABLE IF NOT EXISTS price_book (
  section_type TEXT PRIMARY KEY,
  rate_per_cwt REAL NOT NULL DEFAULT 0,
  updated_at TEXT DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO price_book (section_type, rate_per_cwt) VALUES
  ('W',     0),
  ('HSS',   0),
  ('L',     0),
  ('C',     0),
  ('MC',    0),
  ('WT',    0),
  ('S',     0),
  ('2L',    0),
  ('PLATE', 0),
  ('MISC',  0);
