-- UAT 1.6: retain the complete business context captured when a rework order is initiated.
-- New fields remain nullable for historic completed orders; the application enforces them
-- for newly submitted orders so existing immutable records never need to be rewritten.

ALTER TABLE rework_orders
  ADD COLUMN customer_supply_code varchar(100),
  ADD COLUMN factory_style_no varchar(100),
  ADD COLUMN order_quantity integer,
  ADD COLUMN rework_reason varchar(500),
  ADD COLUMN rework_process varchar(500);

ALTER TABLE rework_orders
  ADD CONSTRAINT rework_orders_order_quantity_positive
  CHECK (order_quantity IS NULL OR order_quantity > 0);
