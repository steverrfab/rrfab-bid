-- Editable descriptions for the two subcontractor lines on Cost Inputs.
--
-- "Joist and Deck - by Subcontractor" and "Erection - by Subcontractor" were
-- hardcoded strings. An estimator pricing a job that includes joist but excludes
-- deck had no way to say so: the line printed "Joist and Deck" on the proposal,
-- the PDF and the SOV regardless. These columns let the description be set per
-- estimate.
--
-- ADDITIVE ONLY, and deliberately nullable with no default. NULL means "use the
-- built-in wording", which is what every existing estimate has, so no proposal,
-- PDF or SOV that exists today changes by a single character. A label only
-- differs once someone types one.

ALTER TABLE estimates ADD COLUMN sub_joist_deck_label TEXT;
ALTER TABLE estimates ADD COLUMN sub_erection_label TEXT;
