-- RECOVERY: the "hide until saved" behavior hid every estimate that wasn't
-- explicitly confirmed via the Save button, making estimators' work look lost.
-- Un-hide everything. Combined with new estimates now being created confirmed=1,
-- nothing gets hidden going forward, so this UPDATE is a no-op on later restarts.
UPDATE estimates SET confirmed = 1 WHERE confirmed = 0 OR confirmed IS NULL;
