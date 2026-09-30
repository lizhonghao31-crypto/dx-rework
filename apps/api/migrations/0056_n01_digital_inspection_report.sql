ALTER TABLE rework_orders
  ADD COLUMN inspection_report jsonb;

ALTER TABLE rework_orders
  ADD CONSTRAINT rework_orders_inspection_report_object_check
  CHECK (inspection_report IS NULL OR jsonb_typeof(inspection_report) = 'object');

COMMENT ON COLUMN rework_orders.inspection_report IS
  'N01 digital inspection report draft/result. Measurements use centimeters with 0.1 precision.';
