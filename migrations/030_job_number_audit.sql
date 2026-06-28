-- Job-number assignment audit.
-- The job_number column itself already exists (001_initial). This adds who
-- assigned it and when, stamped when a bid is gated through Submitted -> Won.
-- Additive only; existing rows get NULLs.
ALTER TABLE estimates ADD COLUMN job_number_assigned_by INTEGER;
ALTER TABLE estimates ADD COLUMN job_number_assigned_at TEXT;
