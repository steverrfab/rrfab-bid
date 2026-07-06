-- Add MC12X14.3, a standard AISC MC (miscellaneous channel) that was missing
-- from the original seed. The MC12 series jumped from MC12X31 straight to
-- MC12X10.6, so a takeoff calling out MC12X14.3 imported at zero weight.
--
-- Additive only. INSERT OR IGNORE never changes an existing row, so every
-- already-saved estimate computes exactly the same as before, and this is
-- safe to re-run on every startup.
--
-- Source: AISC Shapes Database v15.0. For C/MC/W shapes the number after the
-- "X" is the nominal weight per foot, so MC12X14.3 = 14.3 lb/ft.

INSERT OR IGNORE INTO aisc_sections (label, t_f, weight_per_ft) VALUES
  ('MC12X14.3', '', 14.3);
