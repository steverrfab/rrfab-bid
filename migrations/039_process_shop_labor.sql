-- Shop Labor line for Process-Only Additional Costs.
-- Unlike the other additional-cost lines (pure pass-through: cost === price), a
-- line flagged is_labor bills at hours x its rate but costs at hours x the
-- estimate cost rate (po_cost_rate), so the labor markup stays in the margin.
-- Additive + idempotent: the ALTER is skipped on reruns (duplicate column), and
-- the backfill only inserts where no labor row exists yet.

ALTER TABLE process_only_addcosts ADD COLUMN is_labor INTEGER DEFAULT 0;

INSERT INTO process_only_addcosts (estimate_id, position, name, unit, input_qty, rate, is_flat, is_labor)
SELECT a.estimate_id, 100, 'Shop Labor', 'hrs', 0, 85, 0, 1
FROM (SELECT DISTINCT estimate_id FROM process_only_addcosts) a
WHERE NOT EXISTS (
  SELECT 1 FROM process_only_addcosts l
  WHERE l.estimate_id = a.estimate_id AND l.is_labor = 1
);
