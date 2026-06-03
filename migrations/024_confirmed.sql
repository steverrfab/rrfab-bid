-- "Hide until saved" support.
-- confirmed = 1 means the estimate has been saved with required fields and
-- should appear in the list/dashboard. New estimates start at 0 (hidden) until
-- the user saves the Project page. Default 1 so every EXISTING estimate stays
-- visible; the create route inserts new rows with confirmed = 0 explicitly.
ALTER TABLE estimates ADD COLUMN confirmed INTEGER DEFAULT 1;
