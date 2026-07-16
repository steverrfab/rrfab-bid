-- Tracker access level per user. Maps to the Project Tracker's own roles.
-- Allowed values are enforced in code (routes/users.js), not a CHECK:
-- none, shop, pm, accounting, admin. 'none' means no tracker access.
ALTER TABLE users ADD COLUMN tracker_role TEXT NOT NULL DEFAULT 'none';
