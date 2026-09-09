-- Change order numbers are typed by the user, not handed out by the app.
--
-- Until now every change order got an automatic CO-001 / CO-002 in the order it
-- was written. The office numbers change orders to match the GC's paperwork,
-- so the number has to be whatever the user types. It is free text ("CO-07",
-- "PCO 12", "3") and lives in this column.
--
-- SAFE ON EXISTING DATA: this only adds a column. Every change order already in
-- the database gets NULL here and keeps showing its old automatic CO-00N label
-- (see label() in routes/change_orders.js). Nothing is renumbered.
--
-- Uniqueness within a job is enforced in the route, not here, so an existing
-- database can never fail to start over a duplicate.

ALTER TABLE change_orders ADD COLUMN co_number TEXT;
