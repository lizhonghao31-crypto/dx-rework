-- Preserve who decided the whole-inspection cost bearer and remove the
-- unsafe historical own-factory fallback. Existing unfinished supplier
-- orders are biased toward supplier deduction; drafts must be decided again
-- by quality inspection. Table rewrites intentionally avoid audited DML
-- triggers while keeping finalized financial snapshots unchanged.

ALTER TABLE rework_orders
  DROP CONSTRAINT rework_orders_tail_inspection_cost_bearer_check;

CREATE TYPE migration_tail_inspection_cost_bearer_0119 AS ENUM (
  'own_factory',
  'processing_factory'
);

ALTER TABLE rework_orders
  ALTER COLUMN tail_inspection_cost_bearer
    TYPE migration_tail_inspection_cost_bearer_0119
    USING (
      CASE
        WHEN tail_inspection_required IS FALSE THEN NULL
        WHEN status='draft' THEN NULL
        WHEN status IN (
          'pending_process_configuration',
          'pending_ie_review',
          'pending_task_assignment',
          'in_progress',
          'pending_order_review',
          'pending_final_quantity_ie_review',
          'pending_quantity_adjustment_ie_review',
          'pending_responsibility_determination'
        ) AND processing_factory_type='supplier'
          THEN 'processing_factory'::migration_tail_inspection_cost_bearer_0119
        WHEN status IN (
          'pending_process_configuration',
          'pending_ie_review',
          'pending_task_assignment',
          'in_progress',
          'pending_order_review',
          'pending_final_quantity_ie_review',
          'pending_quantity_adjustment_ie_review',
          'pending_responsibility_determination'
        ) THEN NULL
        ELSE tail_inspection_cost_bearer::text::migration_tail_inspection_cost_bearer_0119
      END
    );

ALTER TABLE rework_orders
  ALTER COLUMN tail_inspection_cost_bearer TYPE text
    USING tail_inspection_cost_bearer::text;

DROP TYPE migration_tail_inspection_cost_bearer_0119;

ALTER TABLE rework_orders
  ADD CONSTRAINT rework_orders_tail_inspection_cost_bearer_check
  CHECK (
    tail_inspection_cost_bearer IS NULL
    OR tail_inspection_cost_bearer IN ('own_factory','processing_factory')
  );

CREATE TYPE migration_tail_inspection_cost_bearer_source_0119 AS ENUM (
  'legacy_default',
  'quality_inspection',
  'production_override'
);

ALTER TABLE rework_orders
  ADD COLUMN tail_inspection_cost_bearer_source
    migration_tail_inspection_cost_bearer_source_0119
    NOT NULL DEFAULT 'legacy_default';

ALTER TABLE rework_orders
  ALTER COLUMN tail_inspection_cost_bearer_source DROP DEFAULT,
  ALTER COLUMN tail_inspection_cost_bearer_source DROP NOT NULL,
  ALTER COLUMN tail_inspection_cost_bearer_source TYPE text
    USING (
      CASE
        WHEN tail_inspection_cost_bearer IS NULL THEN NULL
        ELSE tail_inspection_cost_bearer_source::text
      END
    );

DROP TYPE migration_tail_inspection_cost_bearer_source_0119;

ALTER TABLE rework_orders
  ADD CONSTRAINT rework_orders_tail_inspection_cost_bearer_source_check
  CHECK (
    (tail_inspection_cost_bearer IS NULL AND tail_inspection_cost_bearer_source IS NULL)
    OR (
      tail_inspection_cost_bearer IS NOT NULL
      AND tail_inspection_cost_bearer_source IN (
        'legacy_default',
        'quality_inspection',
        'production_override'
      )
    )
  );

COMMENT ON COLUMN rework_orders.tail_inspection_cost_bearer_source IS
  'Decision provenance: quality_inspection is explicit N01 input; legacy_default is a pre-0119 system assumption; production_override is an N07 correction.';

-- Keep the audited existing-order waiver compatible with the new bearer
-- provenance pair. Patch only a guard that already owns the waiver branch.
-- Cropped schema tests intentionally keep their smaller initiation-only guard.

DO $migration$
DECLARE
  guard_source text;
  old_fields constant text :=
    'ARRAY[''status'',''tail_inspection_required'',''updated_by'',''version'',''updated_at'']';
  new_fields constant text :=
    'ARRAY[''status'',''tail_inspection_required'',''tail_inspection_cost_bearer'',''tail_inspection_cost_bearer_source'',''updated_by'',''version'',''updated_at'']';
  old_count integer;
BEGIN
  SELECT procedure.prosrc
  INTO guard_source
  FROM pg_proc procedure
  JOIN pg_namespace namespace ON namespace.oid=procedure.pronamespace
  WHERE namespace.nspname=current_schema()
    AND procedure.proname='guard_rework_order_write'
    AND pg_get_function_identity_arguments(procedure.oid)=''
  ORDER BY procedure.oid DESC
  LIMIT 1;

  IF guard_source IS NULL THEN
    RAISE EXCEPTION 'guard_rework_order_write() is required before migration 0119';
  END IF;

  IF position('rework.tail_inspection.waive' IN guard_source)>0 THEN
    old_count :=
      (length(guard_source)-length(replace(guard_source,old_fields,'')))
      / length(old_fields);
    IF old_count<>2 THEN
      RAISE EXCEPTION 'unexpected tail-inspection waiver guard shape in migration 0119';
    END IF;
    guard_source := replace(guard_source,old_fields,new_fields);
    EXECUTE format(
      'CREATE OR REPLACE FUNCTION guard_rework_order_write() RETURNS trigger LANGUAGE plpgsql AS %L',
      guard_source
    );
  END IF;
END
$migration$;
