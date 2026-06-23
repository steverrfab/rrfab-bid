-- Bid type: lets a user mark a bid as Test/Demo/Superseded so it is kept in the
-- system but excluded from dashboard totals. Only 'real' bids count toward the
-- Estimated/Submitted/Won cards. Default 'real' so every EXISTING bid keeps
-- counting exactly as before; nothing moves retroactively.
ALTER TABLE estimates ADD COLUMN bid_type TEXT DEFAULT 'real';

-- Speeds up the dashboard summary filter.
CREATE INDEX IF NOT EXISTS idx_estimates_bid_type ON estimates(bid_type);
