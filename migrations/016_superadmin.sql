-- Allow the 'superadmin' role, then promote Steve.
--
-- The table rebuild that widens the role CHECK used to live here. Because every
-- migration re-runs on every startup, it rebuilt the users table on every
-- deploy and dropped any column added after it (tracker_role, phone,
-- page_access), resetting them. The rebuild now lives in db.js
-- (allowSuperadminRole), runs just before this file, and only when the table
-- still needs it. Existing databases are left exactly as they are.

-- Promote Steve to superadmin
UPDATE users SET role = 'superadmin' WHERE email = 'stevem@rrfabrication.org' AND role IN ('admin','estimator');
