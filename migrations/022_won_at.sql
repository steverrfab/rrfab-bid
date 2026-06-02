-- Add won_at to estimates: the date/time a bid was marked Won.
-- Used by the dashboard so the Won card can be filtered by time period.
ALTER TABLE estimates ADD COLUMN won_at TEXT;

-- Backfill existing Won estimates with a best-guess win date so historical
-- Won bids still show up under the dashboard time filter.
UPDATE estimates SET won_at = COALESCE(submitted_at, updated_at, created_at) WHERE status = 'Won' AND won_at IS NULL;
