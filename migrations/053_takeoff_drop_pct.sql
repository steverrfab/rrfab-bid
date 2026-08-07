-- Drop as a percentage of a shape row's weight.
--
-- Drop is the waste footage lost when cutting pieces out of stock lengths.
-- Historically it was stored as drop_ft: extra feet charged once per physical
-- piece, added to the row's total length before weight was calculated. The shop
-- asked for it as a percentage of the row's weight instead, which they work out
-- themselves per size, so this adds drop_pct alongside the existing column.
--
-- ADDITIVE ONLY. There is no backfill and no UPDATE against takeoff_shapes.
-- drop_pct defaults to 0, and calc multiplies weight by (1 + drop_pct/100), so
-- every row that exists today is multiplied by 1 and prices to the exact same
-- number it does now. No existing bid is rewritten or repriced by this
-- migration. drop_ft is deliberately left in place and still honoured, so bids
-- entered before this change keep pricing the way they were quoted.
--
-- The ALTER is skipped on re-run by the migration runner, which swallows
-- "duplicate column name".

ALTER TABLE takeoff_shapes ADD COLUMN drop_pct REAL DEFAULT 0;
