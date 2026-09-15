-- Profile page has offered a phone field since the start, and PUT /api/users/:id
-- writes it, but the column never existed on users (only on contacts), so
-- saving a profile with a phone number failed with "no such column".
-- Adds a column only. No existing rows are changed.
ALTER TABLE users ADD COLUMN phone TEXT;
