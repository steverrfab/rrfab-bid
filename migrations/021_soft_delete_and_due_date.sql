-- Add soft-delete (deleted_at) and due_date columns
ALTER TABLE estimates ADD COLUMN due_date TEXT;
ALTER TABLE estimates ADD COLUMN deleted_at TEXT;

-- Add index for soft-delete queries
CREATE INDEX IF NOT EXISTS idx_estimates_deleted ON estimates(deleted_at);
