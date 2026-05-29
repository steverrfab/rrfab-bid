-- Correct default rates to match original R&R Excel template.
-- Only updates rows that still have the old wrong schema defaults
-- so any estimate where someone deliberately changed a rate is left alone.
UPDATE estimates SET fab_rate         = 85   WHERE fab_rate         = 75;
UPDATE estimates SET paint_rate       = 0.08 WHERE paint_rate       = 0.06;
UPDATE estimates SET consumables_rate = 0.03 WHERE consumables_rate = 0.02;
UPDATE estimates SET handling_rate    = 0.05 WHERE handling_rate    = 0.02;
UPDATE estimates SET galv_rate        = 1.00 WHERE galv_rate        = 0.65;
