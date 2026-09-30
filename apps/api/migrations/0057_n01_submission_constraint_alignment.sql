-- N01 manual entry now creates an order from eight required facts.  Replace
-- the original cross-column constraint, which still required the retired
-- merchandiser/problem/rework fields when a draft was submitted.
DO $$
DECLARE
  legacy_constraint_name text;
BEGIN
  SELECT constraint_row.conname
  INTO legacy_constraint_name
  FROM pg_constraint constraint_row
  WHERE constraint_row.conrelid = 'rework_orders'::regclass
    AND constraint_row.contype = 'c'
    AND lower(pg_get_constraintdef(constraint_row.oid))
      LIKE '%status <> ''pending_process_configuration''%'
    AND lower(pg_get_constraintdef(constraint_row.oid))
      LIKE '%merchandiser_user_id is not null%'
    AND lower(pg_get_constraintdef(constraint_row.oid))
      LIKE '%problem_part is not null%'
    AND lower(pg_get_constraintdef(constraint_row.oid))
      LIKE '%problem_description is not null%'
    AND lower(pg_get_constraintdef(constraint_row.oid))
      LIKE '%rework_quantity is not null%'
  ORDER BY constraint_row.conname
  LIMIT 1;

  IF legacy_constraint_name IS NULL THEN
    RAISE EXCEPTION 'legacy rework order submission constraint was not found';
  END IF;

  EXECUTE format(
    'ALTER TABLE rework_orders DROP CONSTRAINT %I',
    legacy_constraint_name
  );
END $$;

ALTER TABLE rework_orders
  ADD CONSTRAINT rework_orders_n01_submission_complete_check CHECK (
    status <> 'pending_process_configuration'
    OR (
      source_system = 'manual'
      AND rework_no IS NOT NULL
      AND style_no IS NOT NULL
      AND processing_factory_type IS NOT NULL
      AND order_quantity IS NOT NULL
      AND inspection_report IS NOT NULL
      AND jsonb_typeof(inspection_report->'styleName') = 'string'
      AND nullif(btrim(inspection_report->>'styleName'), '') IS NOT NULL
      AND jsonb_typeof(inspection_report->'color') = 'string'
      AND nullif(btrim(inspection_report->>'color'), '') IS NOT NULL
      AND jsonb_typeof(inspection_report->'inspectionStage') = 'string'
      AND nullif(btrim(inspection_report->>'inspectionStage'), '') IS NOT NULL
      AND jsonb_typeof(inspection_report->'inspectionLocation') = 'string'
      AND nullif(btrim(inspection_report->>'inspectionLocation'), '') IS NOT NULL
      AND CASE
        WHEN jsonb_typeof(inspection_report->'sampleQuantity') = 'number'
          THEN (inspection_report->>'sampleQuantity')::numeric > 0
        ELSE false
      END
    )
    OR (
      source_system <> 'manual'
      AND rework_no IS NOT NULL
      AND style_no IS NOT NULL
      AND merchandiser_user_id IS NOT NULL
      AND processing_factory_type IS NOT NULL
      AND problem_part IS NOT NULL
      AND problem_description IS NOT NULL
      AND rework_quantity IS NOT NULL
    )
  ) NOT VALID;
