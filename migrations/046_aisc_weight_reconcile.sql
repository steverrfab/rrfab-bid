-- Reconcile 3 legacy section weights to the official AISC value (all 0.1 lb/ft
-- roundings found when cross-checking the table against the official AISC
-- Shapes Database v16.0). seedAisc() tops up NEW shapes by INSERT OR IGNORE and
-- never overwrites an existing row, so these corrections must be explicit UPDATEs
-- (same pattern as the HSS and W36x441 fixes). Idempotent.
--
-- The ~1,000 newly added shapes themselves live in seed/aisc.json and are loaded
-- by seedAisc()'s idempotent top-up; they are not repeated here.

UPDATE aisc_sections SET weight_per_ft = 54.8 WHERE label = 'Pipe10X-STG';
UPDATE aisc_sections SET weight_per_ft = 21.9 WHERE label = 'L8X4X9/16';
UPDATE aisc_sections SET weight_per_ft = 65.5 WHERE label = 'Pipe12X-STG';
