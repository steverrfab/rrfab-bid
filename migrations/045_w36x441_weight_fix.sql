-- Correct W36X441. The AISC designation number is the nominal weight per foot,
-- so W36X441 weighs 441 lb/ft; it was stored as 442. Found by a full sweep of
-- the weight table cross-checking every W/WT/C/S/MC size against the weight
-- encoded in its name (this was the only mismatch).
--
-- seedAisc() only runs on an empty table, so this UPDATE is needed to correct
-- the already-populated live database. Idempotent.

UPDATE aisc_sections SET weight_per_ft = 441 WHERE label = 'W36X441';
