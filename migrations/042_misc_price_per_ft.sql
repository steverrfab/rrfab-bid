-- Misc Metals is priced by length x $/ft (entered by hand), not by weight.
-- Add the two columns the new model needs. Additive + idempotent: the runner
-- skips "duplicate column name" on reruns. Existing rows keep length_ft/
-- price_per_ft = 0, so calc.computeMiscRow falls back to the old qty x
-- weight-each x $/CWT math for them and no saved bid changes until re-entered.
ALTER TABLE takeoff_misc ADD COLUMN length_ft REAL DEFAULT 0;
ALTER TABLE takeoff_misc ADD COLUMN price_per_ft REAL DEFAULT 0;
