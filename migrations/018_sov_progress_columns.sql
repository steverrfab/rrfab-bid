ALTER TABLE sov_items ADD COLUMN prev_completed    REAL NOT NULL DEFAULT 0;
ALTER TABLE sov_items ADD COLUMN this_period       REAL NOT NULL DEFAULT 0;
ALTER TABLE sov_items ADD COLUMN stored_materials  REAL NOT NULL DEFAULT 0;
ALTER TABLE sov_items ADD COLUMN retainage_pct     REAL NOT NULL DEFAULT 0;
