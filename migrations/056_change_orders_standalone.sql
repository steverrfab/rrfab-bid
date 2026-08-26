-- Change orders no longer have to hang off a bid.
--
-- Two parts:
--   1. The two new columns below, which carry the project name and customer for
--      a change order that has no parent estimate. Plain ADD COLUMN, so the
--      migration runner's "duplicate column name" skip makes them idempotent.
--   2. Dropping the NOT NULL on change_orders.estimate_id. SQLite cannot do that
--      with ALTER, it needs a table rebuild, and a rebuild written here would run
--      on every startup because db.js re-runs every migration. So that half lives
--      in db.js as relaxChangeOrderParent(), which inspects PRAGMA table_info and
--      does nothing once the column is already nullable.
--
-- Existing change orders are untouched: they keep their estimate_id, their seq,
-- and their label.

ALTER TABLE change_orders ADD COLUMN project_name TEXT NOT NULL DEFAULT '';
ALTER TABLE change_orders ADD COLUMN client_gc TEXT NOT NULL DEFAULT '';

-- Standalone change orders carry their own running sequence, kept separate from
-- the per-bid sequences. This partial index keeps that lookup cheap.
CREATE INDEX IF NOT EXISTS idx_change_orders_standalone
  ON change_orders(seq) WHERE estimate_id IS NULL;
