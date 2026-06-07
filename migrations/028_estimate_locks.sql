-- Estimate locking: one row per estimate means that estimate is being edited.
-- A lock is considered stale (and ignorable) once last_seen is older than the
-- app's stale threshold. The frontend refreshes last_seen with a heartbeat.
CREATE TABLE IF NOT EXISTS estimate_locks (
  estimate_id INTEGER PRIMARY KEY REFERENCES estimates(id),
  user_id     INTEGER,
  user_name   TEXT DEFAULT '',
  locked_at   TEXT DEFAULT (datetime('now')),
  last_seen   TEXT DEFAULT (datetime('now'))
);
