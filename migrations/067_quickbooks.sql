-- QuickBooks Online: send a Won bid to QB as a project with an estimate under it.
-- Only adds new things. No existing bid, user or setting is changed.

-- QuickBooks access per user, the same shape as crm_role.
-- Allowed values are enforced in code (routes/users.js): none, controller.
-- A controller connects QuickBooks and approves what goes into it. Everyone
-- starts at none; a superadmin always counts as controller (lib/access.js).
ALTER TABLE users ADD COLUMN qb_role TEXT NOT NULL DEFAULT 'none';

-- The one QuickBooks company this tool talks to. Single row (id = 1).
-- item_id / item_name: the QB Product/Service used on every estimate line,
-- picked once by the controller.
CREATE TABLE IF NOT EXISTS qbo_connection (
  id                  INTEGER PRIMARY KEY CHECK (id = 1),
  realm_id            TEXT NOT NULL,
  company_name        TEXT,
  access_token        TEXT NOT NULL,
  refresh_token       TEXT NOT NULL,
  access_expires_at   TEXT NOT NULL,
  refresh_expires_at  TEXT,
  has_project_scope   INTEGER NOT NULL DEFAULT 0,
  item_id             TEXT,
  item_name           TEXT,
  connected_by        INTEGER,
  connected_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The controller's queue. Joe asks, the controller approves, then and only then
-- does anything get written to QuickBooks.
--   status: pending | sent | rejected | failed
--   failed keeps whatever was already created (qb_customer_id, qb_project_id) so
--   a retry carries on instead of making duplicates in QuickBooks.
CREATE TABLE IF NOT EXISTS qbo_push_requests (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  estimate_id      INTEGER NOT NULL REFERENCES estimates(id) ON DELETE CASCADE,
  status           TEXT NOT NULL DEFAULT 'pending',
  requested_by     INTEGER,
  requested_at     TEXT NOT NULL DEFAULT (datetime('now')),
  request_note     TEXT,
  reviewed_by      INTEGER,
  reviewed_at      TEXT,
  review_note      TEXT,
  qb_customer_id   TEXT,
  qb_customer_name TEXT,
  qb_project_id    TEXT,
  qb_project_kind  TEXT,
  qb_estimate_id   TEXT,
  qb_total         REAL,
  error            TEXT,
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_qbo_push_requests_estimate ON qbo_push_requests(estimate_id);
CREATE INDEX IF NOT EXISTS idx_qbo_push_requests_status ON qbo_push_requests(status);
