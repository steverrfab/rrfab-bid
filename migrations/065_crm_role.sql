-- CRM access level per user, the same shape as tracker_role.
-- Allowed values are enforced in code (routes/users.js): none, user.
-- 'none' means no CRM button and no CRM sign-on. Everyone starts at none, so
-- nobody gains access until an admin turns it on for them.
ALTER TABLE users ADD COLUMN crm_role TEXT NOT NULL DEFAULT 'none';
