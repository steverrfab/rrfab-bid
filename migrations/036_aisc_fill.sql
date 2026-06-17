-- Fill gaps in the AISC weight table for common rolled shapes that appear in
-- real takeoffs but were missing from the original seed, so they no longer
-- import at zero weight.
--
-- Additive only. INSERT OR IGNORE never changes an existing row, so every
-- already-saved estimate computes exactly the same as before.
--
-- Sources (AISC Shapes Database v15.0, nominal weight per foot):
--   W21X50, W21X68, C12X14.3, MC12X10.6: for W/C/MC shapes the number after
--     the "X" is the nominal weight per foot (verified against the AISC v15.0
--     database "W" column).
--   HSS1.5X1.5X3/16: 3.04 lb/ft, design wall 0.174" (AISC square HSS table;
--     the 1-1/2 x 1-1/2 x 3/16 railing tube).
--
-- Not included on purpose: L2.25X2.25X1/4. AISC has no 2-1/4 inch angle
-- (equal-leg angles start at L2 and L2-1/2), so this is a nonstandard or
-- mislabeled item. It stays flagged on import for the estimator to weigh.

INSERT OR IGNORE INTO aisc_sections (label, t_f, weight_per_ft) VALUES
  ('W21X50',          '', 50.0),
  ('W21X68',          '', 68.0),
  ('C12X14.3',        '', 14.3),
  ('MC12X10.6',       '', 10.6),
  ('HSS1.5X1.5X3/16', '', 3.04);
