-- Manual weight-per-foot for takeoff shape rows whose section is not in the AISC table.
-- When a user types a section that the AISC lookup cannot resolve (custom/built-up/non-standard),
-- they enter the Wt/Ft by hand and it is stored here. Calc falls back to this value when AISC = 0.
ALTER TABLE takeoff_shapes ADD COLUMN manual_wpf REAL DEFAULT 0;
