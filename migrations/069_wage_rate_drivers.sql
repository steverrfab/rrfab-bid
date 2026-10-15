-- Rate drivers: the numbers behind the company wage rates (insurance premiums,
-- head count and pay by group, monthly overhead), saved with each version of
-- company rates so the history shows what each set of rates was built from.
-- Only adds an empty column. No estimate, wage row or saved rate is changed.
ALTER TABLE company_wage_versions ADD COLUMN drivers_json TEXT;
