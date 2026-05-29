-- Custom extra rows for any Cost Input section (1-4).
-- section 1 = Material, 2 = Fab Labor, 3 = Finishes, 4 = DFE
-- total for each row = qty * rate (dollars), added to the section subtotal.
-- weight_lb (section 1 only) also adds to materialWeight.
CREATE TABLE IF NOT EXISTS estimate_extras (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  estimate_id INTEGER NOT NULL REFERENCES estimates(id) ON DELETE CASCADE,
  section     INTEGER NOT NULL CHECK (section IN (1,2,3,4)),
  position    REAL    NOT NULL DEFAULT 0,
  description TEXT    NOT NULL DEFAULT '',
  unit        TEXT    NOT NULL DEFAULT 'LS',
  qty         REAL    NOT NULL DEFAULT 1,
  rate        REAL    NOT NULL DEFAULT 0,
  weight_lb   REAL    NOT NULL DEFAULT 0,
  notes       TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_extras_estimate ON estimate_extras(estimate_id, section);
