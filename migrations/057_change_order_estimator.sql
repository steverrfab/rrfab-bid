-- Full-estimator change orders.
--
-- A change order priced with the full estimator needs the same machinery a bid
-- has: cost inputs, the markup cascade, a client proposal. Rather than build a
-- second copy of all of that keyed to change_orders, an estimator change order
-- gets its own row in `estimates` and the existing editor opens on it.
--
-- That row is NOT a bid. It has no bid number, it never appears in the bids
-- list, the dashboard, reports, the trash or the change-order target picker.
-- The column below is what every one of those queries filters on: a real bid
-- has change_order_id IS NULL, and always has.
--
-- SAFE ON EXISTING DATA: this only adds a column. Every estimates row that
-- exists today gets NULL, which is exactly "this is a real bid", so nothing
-- that is already in the database changes behaviour or moves.

ALTER TABLE estimates ADD COLUMN change_order_id INTEGER REFERENCES change_orders(id);

-- Safety first: if any database somehow already holds two pricing rows for the
-- same change order, the unique index below would fail to build and the
-- migration runner would abort startup with no way in. So duplicates are stood
-- down first — the OLDEST row is kept, being the one with the priced work on it,
-- and any later ones are soft-deleted rather than destroyed.
--
-- On every database that has never run this feature there are no rows with a
-- change_order_id at all, so this statement matches nothing and changes nothing.
-- The losers are soft-deleted, detached from the change order and marked
-- 'change_order' so they are invisible to every list and absent from every
-- count. The row itself is left intact.
UPDATE estimates
   SET deleted_at = COALESCE(deleted_at, datetime('now')),
       bid_type = 'change_order',
       change_order_id = NULL
 WHERE change_order_id IS NOT NULL
   AND id NOT IN (
     SELECT MIN(id) FROM estimates
      WHERE change_order_id IS NOT NULL
      GROUP BY change_order_id
   );

-- Partial index: UNIQUE only over the rows actually pricing a change order, so a
-- change order can never end up with two and silently pick one. Real bids
-- (change_order_id IS NULL) are not in the index at all.
CREATE UNIQUE INDEX IF NOT EXISTS idx_estimates_change_order
  ON estimates(change_order_id)
  WHERE change_order_id IS NOT NULL;
