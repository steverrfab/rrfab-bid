-- Correct default rates to match original R&R Excel template.
-- Only updates rows that still have the old wrong schema defaults
-- so any estimate where someone deliberately changed a rate is left alone.
--
-- GUARD (added later): db.js re-runs every migration on every startup, so these
-- UPDATEs fired again on each deploy. That meant any rate a user had
-- deliberately set to one of the old values was silently bumped back up on the
-- next restart -- a $75/hr fab rate became $85/hr, galv 0.65 became 1.00, and so
-- on. They are now guarded by the same _data_fixes marker table db.js already
-- uses for reconcileWonLostFamilies, so they run at most once per database.
--
-- A database that already contains estimates has, by definition, already had
-- this fix applied on an earlier boot. Recording the marker first means the
-- UPDATEs below cannot fire even one more time on an existing install. New
-- estimates are created with the corrected rates explicitly (see the INSERT in
-- routes/estimates.js), so nothing depends on these statements going forward.

CREATE TABLE IF NOT EXISTS _data_fixes (name TEXT PRIMARY KEY, applied_at TEXT);

INSERT OR IGNORE INTO _data_fixes (name, applied_at)
  SELECT '008_fix_rate_defaults', datetime('now') FROM estimates LIMIT 1;

UPDATE estimates SET fab_rate         = 85   WHERE fab_rate         = 75   AND NOT EXISTS (SELECT 1 FROM _data_fixes WHERE name = '008_fix_rate_defaults');
UPDATE estimates SET paint_rate       = 0.08 WHERE paint_rate       = 0.06 AND NOT EXISTS (SELECT 1 FROM _data_fixes WHERE name = '008_fix_rate_defaults');
UPDATE estimates SET consumables_rate = 0.03 WHERE consumables_rate = 0.02 AND NOT EXISTS (SELECT 1 FROM _data_fixes WHERE name = '008_fix_rate_defaults');
UPDATE estimates SET handling_rate    = 0.05 WHERE handling_rate    = 0.02 AND NOT EXISTS (SELECT 1 FROM _data_fixes WHERE name = '008_fix_rate_defaults');
UPDATE estimates SET galv_rate        = 1.00 WHERE galv_rate        = 0.65 AND NOT EXISTS (SELECT 1 FROM _data_fixes WHERE name = '008_fix_rate_defaults');

INSERT OR IGNORE INTO _data_fixes (name, applied_at) VALUES ('008_fix_rate_defaults', datetime('now'));
