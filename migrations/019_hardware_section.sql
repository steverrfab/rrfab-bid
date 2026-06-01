-- Add hardware section to estimates (bolts, anchor bolts, fasteners, etc.)
ALTER TABLE estimates ADD COLUMN hardware_weight REAL DEFAULT 0;
ALTER TABLE estimates ADD COLUMN hardware_rate REAL DEFAULT 0.05;
