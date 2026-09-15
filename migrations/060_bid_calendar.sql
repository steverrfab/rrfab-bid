-- Bid Calendar (requested by Joe, 2026-09-15).
-- Adds the time a bid is due, per-user reminder preferences, and a log of
-- reminders already sent so the same one never goes out twice.
-- Adds a column and two tables only. No existing rows are changed; existing
-- bids keep their bid_date and get a NULL bid_time until someone edits them.

ALTER TABLE estimates ADD COLUMN bid_time TEXT;

CREATE TABLE IF NOT EXISTS user_reminder_settings (
  user_id     INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  email_24h   INTEGER NOT NULL DEFAULT 1,
  push_24h    INTEGER NOT NULL DEFAULT 1,
  morning_of  INTEGER NOT NULL DEFAULT 0,
  admin_copy  INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS bid_reminders (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  estimate_id  INTEGER NOT NULL REFERENCES estimates(id) ON DELETE CASCADE,
  user_id      INTEGER NOT NULL,
  kind         TEXT    NOT NULL,
  due_at       TEXT    NOT NULL,
  sent_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  result       TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_bid_reminders_once
  ON bid_reminders (estimate_id, user_id, kind, due_at);
