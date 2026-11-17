-- Versioned rewash plans are appended by the original authorized arrangement.
-- Keep every old snapshot, immutable-history trigger and privilege unchanged.
ALTER TABLE digital_order_time_plan_versions
 DROP CONSTRAINT digital_order_time_plan_versions_input_snapshot_check1;
ALTER TABLE digital_order_time_plan_versions
 ADD CONSTRAINT digital_order_time_plan_input_version CHECK (
  CASE input_snapshot->>'version'
   WHEN 'order-time-input-v1' THEN
    NOT (input_snapshot ? 'rewashing') OR input_snapshot->'rewashing'='[]'::jsonb
   WHEN 'order-time-input-rewash-v1' THEN
    resource_kind='order' AND
    CASE WHEN jsonb_typeof(input_snapshot->'rewashing')='array'
     THEN jsonb_array_length(input_snapshot->'rewashing')>0 ELSE false END
   ELSE false
  END
 );
COMMENT ON CONSTRAINT digital_order_time_plan_input_version ON digital_order_time_plan_versions IS
 'Original v1 snapshots remain readable; explicit rewash-v1 requires an order and a nonempty rewash collection. Exact work, scope, introduction and frozen-policy validation remains in the original plan writer/reader.';
