-- Bid Calendar: "start working by" is a lead time, not a typed date (Steve, 2026-09-17).
-- Every calendar bid gets a start day worked out from its due date: 24 hours,
-- 2 days (the default) or 5 days before. Adds one column with a default, so
-- every bid already on the calendar becomes 2 days. The old start_date column
-- is left in place and no longer read.

ALTER TABLE bid_calendar ADD COLUMN start_lead_days INTEGER NOT NULL DEFAULT 2;
