ALTER TABLE estimates ADD COLUMN created_by INTEGER REFERENCES users(id);
