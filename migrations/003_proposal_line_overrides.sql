-- Editable line descriptions for the customer proposal.
-- Each estimate can override the default label for any of the 7 pricing lines.
-- Blank = use the default text. Dollar amounts stay computed from Cost Inputs.

ALTER TABLE estimates ADD COLUMN proposal_line_1_desc TEXT DEFAULT '';
ALTER TABLE estimates ADD COLUMN proposal_line_2_desc TEXT DEFAULT '';
ALTER TABLE estimates ADD COLUMN proposal_line_3_desc TEXT DEFAULT '';
ALTER TABLE estimates ADD COLUMN proposal_line_4_desc TEXT DEFAULT '';
ALTER TABLE estimates ADD COLUMN proposal_line_5_desc TEXT DEFAULT '';
ALTER TABLE estimates ADD COLUMN proposal_line_6_desc TEXT DEFAULT '';
ALTER TABLE estimates ADD COLUMN proposal_line_7_desc TEXT DEFAULT '';
