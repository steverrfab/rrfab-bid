-- Per-piece drawing number on takeoff shapes. Auto-filled from the takeoff file
-- (external format col B) when present; editable; blank when the estimator
-- didn't include it. The unique set rolls up to estimates.drawing_numbers for
-- the proposal/PDF/SOV.
ALTER TABLE takeoff_shapes ADD COLUMN drawing TEXT DEFAULT '';
