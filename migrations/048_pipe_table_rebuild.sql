-- 048_pipe_table_rebuild.sql
-- Standardize pipe labels to a clean, consistent fraction format
-- (Pipe 1-1/2 STD / X-STG / XXS) and limit the Section dropdown to the
-- true AISC structural pipe range: NPS 1/2 through 12 (small + medium).
-- Adds the small-size double extra strong (XXS) walls that were missing,
-- and removes the oversized 14-26 in. entries that are not AISC pipe.
--
-- Weights on renamed rows are left untouched, so no existing bid reprices;
-- only the new INSERTed rows carry new weights. label_norm is recomputed
-- for every row at startup (db.js), so renamed rows keep resolving old
-- spellings and saved bids are unaffected. Idempotent: renames/deletes
-- match nothing on a second run and inserts use OR IGNORE.

-- Rename existing pipe rows (NPS 1/2-12) to canonical labels (weight kept).
UPDATE aisc_sections SET label = 'Pipe 1/2 STD' WHERE label = 'Pipe1/2STD';
UPDATE aisc_sections SET label = 'Pipe 1/2 X-STG' WHERE label = 'Pipe1/2X-STG';
UPDATE aisc_sections SET label = 'Pipe 1/2 X-STG' WHERE label = 'Pipe1/2XS';
UPDATE aisc_sections SET label = 'Pipe 3/4 STD' WHERE label = 'Pipe3/4STD';
UPDATE aisc_sections SET label = 'Pipe 3/4 X-STG' WHERE label = 'Pipe3/4X-STG';
UPDATE aisc_sections SET label = 'Pipe 3/4 X-STG' WHERE label = 'Pipe3/4XS';
UPDATE aisc_sections SET label = 'Pipe 1 STD' WHERE label = 'Pipe1STD';
UPDATE aisc_sections SET label = 'Pipe 1 X-STG' WHERE label = 'Pipe1X-STG';
UPDATE aisc_sections SET label = 'Pipe 1 X-STG' WHERE label = 'Pipe1XS';
UPDATE aisc_sections SET label = 'Pipe 1-1/4 STD' WHERE label = 'Pipe1-1/4STD';
UPDATE aisc_sections SET label = 'Pipe 1-1/4 STD' WHERE label = 'Pipe1.25STD';
UPDATE aisc_sections SET label = 'Pipe 1-1/4 X-STG' WHERE label = 'Pipe1-1/4X-STG';
UPDATE aisc_sections SET label = 'Pipe 1-1/4 X-STG' WHERE label = 'Pipe1.25X-STG';
UPDATE aisc_sections SET label = 'Pipe 1-1/4 X-STG' WHERE label = 'Pipe1-1/4XS';
UPDATE aisc_sections SET label = 'Pipe 1-1/4 X-STG' WHERE label = 'Pipe1.25XS';
UPDATE aisc_sections SET label = 'Pipe 1-1/2 STD' WHERE label = 'Pipe1-1/2STD';
UPDATE aisc_sections SET label = 'Pipe 1-1/2 STD' WHERE label = 'Pipe1.5STD';
UPDATE aisc_sections SET label = 'Pipe 1-1/2 X-STG' WHERE label = 'Pipe1-1/2XS';
UPDATE aisc_sections SET label = 'Pipe 1-1/2 X-STG' WHERE label = 'Pipe1.5X-STG';
UPDATE aisc_sections SET label = 'Pipe 1-1/2 X-STG' WHERE label = 'Pipe1-1/2X-STG';
UPDATE aisc_sections SET label = 'Pipe 1-1/2 X-STG' WHERE label = 'Pipe1.5XS';
UPDATE aisc_sections SET label = 'Pipe 2 STD' WHERE label = 'Pipe2STD';
UPDATE aisc_sections SET label = 'Pipe 2 X-STG' WHERE label = 'Pipe2XS';
UPDATE aisc_sections SET label = 'Pipe 2 X-STG' WHERE label = 'Pipe2X-STG';
UPDATE aisc_sections SET label = 'Pipe 2 XXS' WHERE label = 'Pipe2XXS';
UPDATE aisc_sections SET label = 'Pipe 2-1/2 STD' WHERE label = 'Pipe2-1/2STD';
UPDATE aisc_sections SET label = 'Pipe 2-1/2 STD' WHERE label = 'Pipe2.5STD';
UPDATE aisc_sections SET label = 'Pipe 2-1/2 X-STG' WHERE label = 'Pipe2-1/2X-STG';
UPDATE aisc_sections SET label = 'Pipe 2-1/2 X-STG' WHERE label = 'Pipe2.5XS';
UPDATE aisc_sections SET label = 'Pipe 2-1/2 X-STG' WHERE label = 'Pipe2-1/2XS';
UPDATE aisc_sections SET label = 'Pipe 2-1/2 X-STG' WHERE label = 'Pipe2.5X-STG';
UPDATE aisc_sections SET label = 'Pipe 2-1/2 XXS' WHERE label = 'Pipe2-1/2XXS';
UPDATE aisc_sections SET label = 'Pipe 2-1/2 XXS' WHERE label = 'Pipe2.5XXS';
UPDATE aisc_sections SET label = 'Pipe 3 STD' WHERE label = 'Pipe3STD';
UPDATE aisc_sections SET label = 'Pipe 3 X-STG' WHERE label = 'Pipe3XS';
UPDATE aisc_sections SET label = 'Pipe 3 X-STG' WHERE label = 'Pipe3X-STG';
UPDATE aisc_sections SET label = 'Pipe 3 XXS' WHERE label = 'Pipe3XXS';
UPDATE aisc_sections SET label = 'Pipe 3-1/2 STD' WHERE label = 'Pipe3-1/2STD';
UPDATE aisc_sections SET label = 'Pipe 3-1/2 STD' WHERE label = 'Pipe3.5STD';
UPDATE aisc_sections SET label = 'Pipe 3-1/2 X-STG' WHERE label = 'Pipe3.5X-STG';
UPDATE aisc_sections SET label = 'Pipe 3-1/2 X-STG' WHERE label = 'Pipe3-1/2X-STG';
UPDATE aisc_sections SET label = 'Pipe 3-1/2 X-STG' WHERE label = 'Pipe3-1/2XS';
UPDATE aisc_sections SET label = 'Pipe 3-1/2 X-STG' WHERE label = 'Pipe3.5XS';
UPDATE aisc_sections SET label = 'Pipe 4 STD' WHERE label = 'Pipe4STD';
UPDATE aisc_sections SET label = 'Pipe 4 X-STG' WHERE label = 'Pipe4X-STG';
UPDATE aisc_sections SET label = 'Pipe 4 X-STG' WHERE label = 'Pipe4XS';
UPDATE aisc_sections SET label = 'Pipe 4 XXS' WHERE label = 'Pipe4XXS';
UPDATE aisc_sections SET label = 'Pipe 5 STD' WHERE label = 'Pipe5STD';
UPDATE aisc_sections SET label = 'Pipe 5 X-STG' WHERE label = 'Pipe5X-STG';
UPDATE aisc_sections SET label = 'Pipe 5 X-STG' WHERE label = 'Pipe5XS';
UPDATE aisc_sections SET label = 'Pipe 5 XXS' WHERE label = 'Pipe5XXS';
UPDATE aisc_sections SET label = 'Pipe 6 STD' WHERE label = 'Pipe6STD';
UPDATE aisc_sections SET label = 'Pipe 6 X-STG' WHERE label = 'Pipe6XS';
UPDATE aisc_sections SET label = 'Pipe 6 X-STG' WHERE label = 'Pipe6X-STG';
UPDATE aisc_sections SET label = 'Pipe 6 XXS' WHERE label = 'Pipe6XXS';
UPDATE aisc_sections SET label = 'Pipe 8 STD' WHERE label = 'Pipe8STD';
UPDATE aisc_sections SET label = 'Pipe 8 X-STG' WHERE label = 'Pipe8X-STG';
UPDATE aisc_sections SET label = 'Pipe 8 X-STG' WHERE label = 'Pipe8XS';
UPDATE aisc_sections SET label = 'Pipe 8 XXS' WHERE label = 'Pipe8XXS';
UPDATE aisc_sections SET label = 'Pipe 10 STD' WHERE label = 'Pipe10STD';
UPDATE aisc_sections SET label = 'Pipe 10 X-STG' WHERE label = 'Pipe10X-STG';
UPDATE aisc_sections SET label = 'Pipe 10 X-STG' WHERE label = 'Pipe10XS';
UPDATE aisc_sections SET label = 'Pipe 10 XXS' WHERE label = 'Pipe10XXS';
UPDATE aisc_sections SET label = 'Pipe 12 STD' WHERE label = 'Pipe12STD';
UPDATE aisc_sections SET label = 'Pipe 12 X-STG' WHERE label = 'Pipe12XS';
UPDATE aisc_sections SET label = 'Pipe 12 X-STG' WHERE label = 'Pipe12X-STG';
UPDATE aisc_sections SET label = 'Pipe 12 XXS' WHERE label = 'Pipe12XXS';

-- Add the small-size XXS walls that were missing from the table.
INSERT OR IGNORE INTO aisc_sections (label, t_f, weight_per_ft) VALUES ('Pipe 1/2 XXS', '', 1.71);
INSERT OR IGNORE INTO aisc_sections (label, t_f, weight_per_ft) VALUES ('Pipe 3/4 XXS', '', 2.44);
INSERT OR IGNORE INTO aisc_sections (label, t_f, weight_per_ft) VALUES ('Pipe 1 XXS', '', 3.66);
INSERT OR IGNORE INTO aisc_sections (label, t_f, weight_per_ft) VALUES ('Pipe 1-1/4 XXS', '', 5.21);
INSERT OR IGNORE INTO aisc_sections (label, t_f, weight_per_ft) VALUES ('Pipe 1-1/2 XXS', '', 6.41);

-- Remove oversized 14-26 in. pipe (not part of the AISC pipe range).
-- Any legacy bid that referenced one falls back to a hand-entered weight.
DELETE FROM aisc_sections WHERE label = 'Pipe 14 STD';
DELETE FROM aisc_sections WHERE label = 'Pipe 14 X-STG';
DELETE FROM aisc_sections WHERE label = 'Pipe 16 STD';
DELETE FROM aisc_sections WHERE label = 'Pipe 16 X-STG';
DELETE FROM aisc_sections WHERE label = 'Pipe 18 STD';
DELETE FROM aisc_sections WHERE label = 'Pipe 18 X-STG';
DELETE FROM aisc_sections WHERE label = 'Pipe 20 STD';
DELETE FROM aisc_sections WHERE label = 'Pipe 20 X-STG';
DELETE FROM aisc_sections WHERE label = 'Pipe 22 STD';
DELETE FROM aisc_sections WHERE label = 'Pipe 22 X-STG';
DELETE FROM aisc_sections WHERE label = 'Pipe 24 STD';
DELETE FROM aisc_sections WHERE label = 'Pipe 24 X-STG';
DELETE FROM aisc_sections WHERE label = 'Pipe 26 STD';
DELETE FROM aisc_sections WHERE label = 'Pipe 26 X-STG';
DELETE FROM aisc_sections WHERE label = 'Pipe14STD';
DELETE FROM aisc_sections WHERE label = 'Pipe14X-STG';
DELETE FROM aisc_sections WHERE label = 'Pipe14XS';
DELETE FROM aisc_sections WHERE label = 'Pipe16STD';
DELETE FROM aisc_sections WHERE label = 'Pipe16X-STG';
DELETE FROM aisc_sections WHERE label = 'Pipe16XS';
DELETE FROM aisc_sections WHERE label = 'Pipe18STD';
DELETE FROM aisc_sections WHERE label = 'Pipe18X-STG';
DELETE FROM aisc_sections WHERE label = 'Pipe18XS';
DELETE FROM aisc_sections WHERE label = 'Pipe20STD';
DELETE FROM aisc_sections WHERE label = 'Pipe20X-STG';
DELETE FROM aisc_sections WHERE label = 'Pipe20XS';
DELETE FROM aisc_sections WHERE label = 'Pipe22STD';
DELETE FROM aisc_sections WHERE label = 'Pipe22X-STG';
DELETE FROM aisc_sections WHERE label = 'Pipe22XS';
DELETE FROM aisc_sections WHERE label = 'Pipe24STD';
DELETE FROM aisc_sections WHERE label = 'Pipe24X-STG';
DELETE FROM aisc_sections WHERE label = 'Pipe24XS';
DELETE FROM aisc_sections WHERE label = 'Pipe26STD';
DELETE FROM aisc_sections WHERE label = 'Pipe26X-STG';
DELETE FROM aisc_sections WHERE label = 'Pipe26XS';
