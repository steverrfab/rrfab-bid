-- Add qty fields for Section 4 and Section 5 cost input rows.
-- Existing rows default to qty=1 so totals are unchanged.
ALTER TABLE estimates ADD COLUMN struct_detailing_qty REAL NOT NULL DEFAULT 1;
ALTER TABLE estimates ADD COLUMN misc_detailing_qty   REAL NOT NULL DEFAULT 1;
ALTER TABLE estimates ADD COLUMN pe_stamp_qty         REAL NOT NULL DEFAULT 1;
ALTER TABLE estimates ADD COLUMN freight_qty          REAL NOT NULL DEFAULT 1;
ALTER TABLE estimates ADD COLUMN erection_equip_qty   REAL NOT NULL DEFAULT 1;
ALTER TABLE estimates ADD COLUMN sub_joist_deck_qty   REAL NOT NULL DEFAULT 1;
ALTER TABLE estimates ADD COLUMN sub_erection_qty     REAL NOT NULL DEFAULT 1;
