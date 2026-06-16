-- Notes shown on the client proposal. Additive and blank by default, so every
-- existing proposal is unchanged until a note is typed.
ALTER TABLE estimates ADD COLUMN proposal_notes TEXT DEFAULT '';
