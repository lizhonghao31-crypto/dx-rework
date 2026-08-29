-- Distinguish tail-inspection cost ownership from whether tail inspection is required.
-- Existing orders retain company-funded behavior; the identified 4223 order is
-- corrected during the table rewrite without bypassing audited DML guards.

CREATE TYPE migration_tail_inspection_cost_bearer AS ENUM (
  'own_factory',
  'processing_factory'
);

ALTER TABLE rework_orders
  ADD COLUMN tail_inspection_cost_bearer migration_tail_inspection_cost_bearer
    NOT NULL DEFAULT 'own_factory';

ALTER TABLE rework_orders
  ALTER COLUMN tail_inspection_cost_bearer DROP DEFAULT,
  ALTER COLUMN tail_inspection_cost_bearer DROP NOT NULL,
  ALTER COLUMN tail_inspection_cost_bearer TYPE text
    USING (
      CASE
        WHEN tail_inspection_required IS FALSE THEN NULL
        WHEN rework_no='RW-2026-0826-001' AND style_no='HO20544223'
          THEN 'processing_factory'
        ELSE tail_inspection_cost_bearer::text
      END
    );

DROP TYPE migration_tail_inspection_cost_bearer;

ALTER TABLE rework_orders
  ADD CONSTRAINT rework_orders_tail_inspection_cost_bearer_check
  CHECK (
    tail_inspection_cost_bearer IS NULL
    OR tail_inspection_cost_bearer IN ('own_factory','processing_factory')
  );

COMMENT ON COLUMN rework_orders.tail_inspection_cost_bearer IS
  'Required business decision when tail inspection is enabled: own_factory keeps the wage internal; processing_factory adds the tail wage to external responsibility at the controlled multiplier.';

