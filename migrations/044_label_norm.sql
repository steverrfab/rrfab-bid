-- Add a normalized-label column used for all section matching so that
-- equivalent spellings (fractions vs decimals, spacing, case) resolve to the
-- same section. Example: a takeoff that says "Pipe 1-1/2 STD" now matches the
-- stored "Pipe1.5STD".
--
-- The column is populated in JS at startup (db.js normalizeSections), not here,
-- because the fraction-to-decimal conversion needs real arithmetic that SQL
-- cannot do. This migration only creates the column and its index; both are
-- safe to run every startup (ADD COLUMN is caught by the duplicate-column
-- guard in the migration runner, and the index uses IF NOT EXISTS).

ALTER TABLE aisc_sections ADD COLUMN label_norm TEXT;

CREATE INDEX IF NOT EXISTS idx_aisc_label_norm ON aisc_sections(label_norm);
