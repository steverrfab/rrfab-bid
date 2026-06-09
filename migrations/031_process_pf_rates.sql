-- Process Only: separate per-piece P&F (fab) rates for beams, channels, angles.
-- Default 0 means "not set" so calc_process falls back to po_beam_fab_rate.
-- Keeps existing process-only quotes unchanged until filled in. Process-only only.
ALTER TABLE estimates ADD COLUMN po_pf_rate_beam    REAL DEFAULT 0;
ALTER TABLE estimates ADD COLUMN po_pf_rate_channel REAL DEFAULT 0;
ALTER TABLE estimates ADD COLUMN po_pf_rate_angle   REAL DEFAULT 0;
