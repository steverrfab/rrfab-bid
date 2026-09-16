-- Per-user page access (see lib/access.js).
--
-- SAFE ON EXISTING DATA: this only adds a column. Every user gets NULL, which
-- means "use the role's defaults", and those defaults are exactly what each
-- role could see before this migration. Nobody's access changes until an admin
-- changes it on the Users screen.

ALTER TABLE users ADD COLUMN page_access TEXT;
