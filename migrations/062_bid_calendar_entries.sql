-- Bid Calendar v2 (Joe, 2026-09-17).
-- The calendar is now its own list of bid invites. An estimator adds one when a
-- GC email or bid board invite comes in, long before any estimate exists, and
-- links it to an estimate later (one estimate per invite, so one per GC).
-- Adds two tables only. No existing rows are changed. The one-time copy of
-- bids that were already on the calendar lives in db.js (copyCalendarFromEstimates)
-- because this file re-runs on every startup.

CREATE TABLE IF NOT EXISTS bid_calendar (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  project_name TEXT    NOT NULL DEFAULT '',
  client_gc    TEXT    NOT NULL DEFAULT '',
  source       TEXT    NOT NULL DEFAULT '',
  due_date     TEXT    NOT NULL,
  due_time     TEXT,
  start_date   TEXT,
  assigned_to  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  docs_url     TEXT    NOT NULL DEFAULT '',
  notes        TEXT    NOT NULL DEFAULT '',
  estimate_id  INTEGER REFERENCES estimates(id) ON DELETE SET NULL,
  created_by   INTEGER,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  deleted_at   TEXT
);

CREATE INDEX IF NOT EXISTS idx_bid_calendar_due ON bid_calendar (due_date);
CREATE INDEX IF NOT EXISTS idx_bid_calendar_assigned ON bid_calendar (assigned_to);

-- One estimate per calendar bid.
CREATE UNIQUE INDEX IF NOT EXISTS idx_bid_calendar_estimate_once
  ON bid_calendar (estimate_id) WHERE estimate_id IS NOT NULL AND deleted_at IS NULL;

-- Reminders sent for calendar bids, so the same one never goes out twice.
CREATE TABLE IF NOT EXISTS calendar_reminders (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id  INTEGER NOT NULL REFERENCES bid_calendar(id) ON DELETE CASCADE,
  user_id   INTEGER NOT NULL,
  kind      TEXT    NOT NULL,
  due_at    TEXT    NOT NULL,
  sent_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  result    TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_calendar_reminders_once
  ON calendar_reminders (entry_id, user_id, kind, due_at);
