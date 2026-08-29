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
