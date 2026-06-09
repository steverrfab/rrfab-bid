-- Add Alternates.
-- An alternate is a full estimate record linked to a parent base bid, so it
-- reuses the entire estimate machinery (takeoff, cost inputs, finishes, calc).
-- Additive only. Existing estimates get is_alternate = 0 and parent_estimate_id
-- NULL, so they remain normal base bids and the current flow is unchanged.

-- 1 if this row is an alternate attached to a parent bid; 0 for a normal bid.
ALTER TABLE estimates ADD COLUMN is_alternate INTEGER NOT NULL DEFAULT 0;

-- The parent base-bid estimate id this alternate belongs to (NULL for normal bids).
ALTER TABLE estimates ADD COLUMN parent_estimate_id INTEGER DEFAULT NULL;

-- User-facing name for the alternate, e.g. "Railings".
ALTER TABLE estimates ADD COLUMN alt_label TEXT DEFAULT '';

-- Ordering of alternates under their parent (Alternate 1, 2, 3...).
ALTER TABLE estimates ADD COLUMN alt_position INTEGER DEFAULT 0;
