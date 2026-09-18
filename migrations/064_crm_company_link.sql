-- Link a bid to a real company in the CRM instead of only a typed name.
--
-- client_gc stays exactly as it is: it is what prints on the proposal and what the
-- estimator typed. crm_company_id is the join, and crm_company_name is a cached copy
-- of the CRM's spelling so a bid still opens, prints and reads correctly when the CRM
-- is unreachable. Both are nullable on purpose: a bid must never be blocked because a
-- company has not been created yet.
ALTER TABLE estimates ADD COLUMN crm_company_id TEXT;
ALTER TABLE estimates ADD COLUMN crm_company_name TEXT;
CREATE INDEX IF NOT EXISTS idx_estimates_crm_company ON estimates (crm_company_id);
