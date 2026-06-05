-- Dedicated drawing numbers field (was previously baked into the scope text on
-- external takeoff upload, which overwrote the user's scope). Now stored on its
-- own so it works for any job type (full, process-only) and prints on the PDF.
ALTER TABLE estimates ADD COLUMN drawing_numbers TEXT DEFAULT '';
