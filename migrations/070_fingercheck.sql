-- Fingercheck payroll pull for Settings > Company Wage Rates.
-- Only adds new tables. No estimate, wage row or saved company rate is changed.

-- Each press of "Refresh from Fingercheck" is kept as its own snapshot.
-- employees_json holds one entry per active employee: number, name, the
-- Fingercheck labels used to group them, current hourly rate, and their last
-- 12 months of hours, gross pay and employer taxes. No SSN, birth date,
-- address or bank details are ever stored.
-- totals_json holds the company-wide 12 month totals, including employees who
-- have since left.
CREATE TABLE IF NOT EXISTS fingercheck_snapshots (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  pulled_at      TEXT NOT NULL DEFAULT (datetime('now')),
  pulled_by      INTEGER,
  pulled_by_name TEXT,
  period_start   TEXT,
  period_end     TEXT,
  employees_json TEXT NOT NULL,
  totals_json    TEXT
);

-- Which rate driver pay group each person is in (direct shop, direct field,
-- shop support, office) or left out. Set once per employee in Settings.
-- Keyed on the Fingercheck employee number so it survives every refresh.
CREATE TABLE IF NOT EXISTS fingercheck_employee_groups (
  employee_number TEXT PRIMARY KEY,
  grp             TEXT NOT NULL CHECK (grp IN ('direct_shop','direct_field','support','office','exclude')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
