-- Client Proposal becomes the final word on a bid's totals (dashboard, bid
-- list, Project tab, Margin Analysis, tax summary, tracker push).
--
-- Adds one flag column. Every bid that already exists gets 0, which keeps it
-- on the old rule: its totals are exactly what they were before this migration.
-- Only bids created after this ships are stamped 1 (see createEstimate). No
-- price, cost, or line on any existing bid is changed.
ALTER TABLE estimates ADD COLUMN proposal_drives_totals INTEGER NOT NULL DEFAULT 0;
