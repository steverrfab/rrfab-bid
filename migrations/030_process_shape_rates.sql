-- Process Only: separate per-piece Process rates for beams, channels, and angles.
-- Default 0 means "not set" so calc_process falls back to the single
-- po_process_rate. This keeps every existing process-only quote unchanged until
-- the user fills these in. Only affects process_only jobs.
ALTER TABLE estimates ADD COLUMN po_process_rate_beam    REAL DEFAULT 0;
ALTER TABLE estimates ADD COLUMN po_process_rate_channel REAL DEFAULT 0;
ALTER TABLE estimates ADD COLUMN po_process_rate_angle   REAL DEFAULT 0;
