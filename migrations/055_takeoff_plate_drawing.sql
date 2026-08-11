-- Drawing number on plate takeoff rows.
--
-- The Takeoff tab has always drawn a "Drawing #" cell on the plate grid, but
-- takeoff_plates had no column behind it and the save route never sent one, so
-- anything typed there was discarded on the next reload. Shape rows have had a
-- drawing column since the takeoff rebuild; this brings plates in line.
--
-- ADDITIVE ONLY. This adds one new empty column. There is no backfill and no
-- UPDATE against takeoff_plates, so no existing plate row is read, rewritten or
-- repriced. drawing is not used in any weight or price calculation.
--
-- The ALTER is skipped on re-run by the migration runner, which swallows
-- "duplicate column name".

ALTER TABLE takeoff_plates ADD COLUMN drawing TEXT DEFAULT '';
