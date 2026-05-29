-- Expand role constraint to include 'superadmin', then promote Steve.
-- SQLite requires table recreation to modify a CHECK constraint.
PRAGMA foreign_keys=OFF;

CREATE TABLE users_new (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  name          TEXT    NOT NULL DEFAULT '',
  role          TEXT    NOT NULL DEFAULT 'estimator' CHECK (role IN ('admin','estimator','superadmin')),
  password_hash TEXT    DEFAULT NULL,
  active        INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO users_new SELECT id, email, name, role, password_hash, active, created_at FROM users;

DROP TABLE users;
ALTER TABLE users_new RENAME TO users;

PRAGMA foreign_keys=ON;

-- Promote Steve to superadmin
UPDATE users SET role = 'superadmin' WHERE email = 'stevem@rrfabrication.org' AND role IN ('admin','estimator');
