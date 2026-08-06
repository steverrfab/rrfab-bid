-- Per-piece quantity for takeoff shape slots.
--
-- Each shape row has up to 8 length slots (l1..l8). Historically each slot held
-- one piece length in feet and the row's total length was just the sum of those
-- lengths. This adds a matching count per slot: l<n> is a piece length in feet,
-- q<n> is how many pieces are that long, so a single slot can carry "10 pieces
-- of 20 ft" (l=20, q=10) instead of needing one row per identical piece.
--
-- Additive + idempotent. The ALTERs are skipped on re-run by the migration
-- runner (it swallows "duplicate column name"). The one-time backfill is guarded
-- by a _data_fixes marker so it runs exactly once: it can never re-clobber a
-- count a user has since edited on a later startup.
--
-- Backfill: q<n> = 1 wherever l<n> > 0, else 0. This makes every existing row
-- price identically to before, because calc treats each filled slot as one piece
-- (length x 1) and the drop total as drop_ft x (number of filled slots), exactly
-- as the old sum-of-lengths math did.

ALTER TABLE takeoff_shapes ADD COLUMN q1 REAL DEFAULT 0;
ALTER TABLE takeoff_shapes ADD COLUMN q2 REAL DEFAULT 0;
ALTER TABLE takeoff_shapes ADD COLUMN q3 REAL DEFAULT 0;
ALTER TABLE takeoff_shapes ADD COLUMN q4 REAL DEFAULT 0;
ALTER TABLE takeoff_shapes ADD COLUMN q5 REAL DEFAULT 0;
ALTER TABLE takeoff_shapes ADD COLUMN q6 REAL DEFAULT 0;
ALTER TABLE takeoff_shapes ADD COLUMN q7 REAL DEFAULT 0;
ALTER TABLE takeoff_shapes ADD COLUMN q8 REAL DEFAULT 0;

CREATE TABLE IF NOT EXISTS _data_fixes (name TEXT PRIMARY KEY, applied_at TEXT);

UPDATE takeoff_shapes SET
  q1 = CASE WHEN l1 > 0 THEN 1 ELSE 0 END,
  q2 = CASE WHEN l2 > 0 THEN 1 ELSE 0 END,
  q3 = CASE WHEN l3 > 0 THEN 1 ELSE 0 END,
  q4 = CASE WHEN l4 > 0 THEN 1 ELSE 0 END,
  q5 = CASE WHEN l5 > 0 THEN 1 ELSE 0 END,
  q6 = CASE WHEN l6 > 0 THEN 1 ELSE 0 END,
  q7 = CASE WHEN l7 > 0 THEN 1 ELSE 0 END,
  q8 = CASE WHEN l8 > 0 THEN 1 ELSE 0 END
WHERE NOT EXISTS (SELECT 1 FROM _data_fixes WHERE name = '052_takeoff_length_qty');

INSERT OR IGNORE INTO _data_fixes (name, applied_at) VALUES ('052_takeoff_length_qty', datetime('now'));
