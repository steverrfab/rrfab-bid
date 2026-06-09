-- Persist user feedback so it can be triaged automatically, not just emailed.
-- status: 'new' (not yet looked at) | 'reviewing' (fix prepared, awaiting push)
--         | 'answered' (was user confusion, explanation given) | 'done'
CREATE TABLE IF NOT EXISTS feedback (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at  TEXT DEFAULT (datetime('now')),
  user_id     INTEGER,
  user_name   TEXT DEFAULT '',
  user_email  TEXT DEFAULT '',
  context     TEXT DEFAULT '',
  message     TEXT NOT NULL,
  status      TEXT DEFAULT 'new',
  resolution  TEXT DEFAULT '',
  handled_at  TEXT
);
