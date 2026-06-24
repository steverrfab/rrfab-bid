-- Durable revision lineage. revised_from_id records which bid a revision was
-- copied from when created via "Revise", independent of the bid number. NULL on
-- originals. Additive + idempotent: the duplicate-column error is swallowed by
-- the migration runner on reruns.
ALTER TABLE estimates ADD COLUMN revised_from_id INTEGER;
CREATE INDEX IF NOT EXISTS idx_estimates_revised_from ON estimates(revised_from_id);
