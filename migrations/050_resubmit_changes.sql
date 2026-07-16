-- Auto change-capture for resubmits.
-- estimates.submit_snapshot holds a JSON snapshot of the bid's priced inputs,
-- captured on submit and refreshed on each resubmit, so the next resubmit can
-- diff against it. estimate_resubmits.changes holds the JSON array of
-- human-readable changes detected for that resubmit. Both additive and nullable;
-- existing rows and bids are unaffected.
ALTER TABLE estimates ADD COLUMN submit_snapshot TEXT;
ALTER TABLE estimate_resubmits ADD COLUMN changes TEXT;
