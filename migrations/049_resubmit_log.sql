-- Resubmit history: one row each time a Submitted bid is resubmitted in place
-- (a quick change that reuses the same bid number instead of creating a new
-- revision). Records the required reason, who did it, and when. Purely additive
-- and empty for any bid that has never been resubmitted, so existing bids are
-- unaffected.
CREATE TABLE IF NOT EXISTS estimate_resubmits (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  estimate_id INTEGER NOT NULL REFERENCES estimates(id),
  note        TEXT NOT NULL,
  user_id     INTEGER,
  user_name   TEXT DEFAULT '',
  created_at  TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_estimate_resubmits_estimate ON estimate_resubmits(estimate_id);
