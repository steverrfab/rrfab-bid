-- Add weight_lb field to takeoff_plates for external estimator imports
ALTER TABLE takeoff_plates ADD COLUMN weight_lb REAL DEFAULT 0;
