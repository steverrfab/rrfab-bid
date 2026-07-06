-- Remove two nonstandard entries confirmed not to exist in AISC:
--   C12X14.3 - there is no such channel (C12 is only 30, 25, 20.7). Almost
--              certainly a typo for MC12X14.3, which is in the table correctly.
--   W36X800  - the real AISC shape is W36X802, which is in the table.
-- Approved for removal. seedAisc() top-up will not re-add them because they were
-- also removed from seed/aisc.json. Idempotent.

DELETE FROM aisc_sections WHERE label IN ('C12X14.3', 'W36X800');
