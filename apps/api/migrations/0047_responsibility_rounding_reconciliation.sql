-- Reconcile historical responsibility rounding without rewriting immutable decisions.
--
-- Before migration 0045, responsibility lines could be rounded from operational
-- shares while wages were settled separately.  On half-cent boundaries this can
-- leave a small difference between the current finalized responsibility total
-- and the settled wage base.  Corrections are append-only and apply only to
-- determinations finalized before 0045 was installed.

CREATE TABLE rework_responsibility_rounding_adjustments (
  adjustment_id uuid PRIMARY KEY,
  determination_id uuid NOT NULL,
  configuration_item_id uuid NOT NULL,
  responsibility_type text NOT NULL CHECK (
    responsibility_type IN (
      'own_factory',
      'processing_factory',
      'embroidery_factory',
      'washing_factory',
      'fabric_supplier'
    )
  ),
  adjustment_amount numeric(18,2) NOT NULL CHECK (
    adjustment_amount <> 0
    AND abs(adjustment_amount) <= 0.05
  ),
  original_process_total numeric(18,2) NOT NULL CHECK (
    original_process_total >= 0
  ),
  settled_target_total numeric(18,2) NOT NULL CHECK (
    settled_target_total >= 0
  ),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (adjustment_id),
  UNIQUE (determination_id, configuration_item_id),
  FOREIGN KEY (determination_id, configuration_item_id)
    REFERENCES rework_responsibility_processes (
      determination_id,
      configuration_item_id
    ),
  FOREIGN KEY (
    determination_id,
    configuration_item_id,
    responsibility_type
  ) REFERENCES rework_responsibility_allocations (
    determination_id,
    configuration_item_id,
    responsibility_type
  )
);

CREATE TRIGGER responsibility_rounding_adjustment_no_update
BEFORE UPDATE ON rework_responsibility_rounding_adjustments
FOR EACH ROW EXECUTE FUNCTION reject_responsibility_mutation();

CREATE TRIGGER responsibility_rounding_adjustment_no_delete
BEFORE DELETE ON rework_responsibility_rounding_adjustments
FOR EACH ROW EXECUTE FUNCTION reject_responsibility_mutation();

CREATE TRIGGER responsibility_rounding_adjustment_no_truncate
BEFORE TRUNCATE ON rework_responsibility_rounding_adjustments
FOR EACH STATEMENT EXECUTE FUNCTION reject_responsibility_mutation();

WITH migration_cutoff AS (
  SELECT applied_at
  FROM schema_migrations
  WHERE version = '0045_responsibility_settled_wage_base'
),
current_finalized AS (
  SELECT determination.*
  FROM rework_responsibility_determinations determination
  CROSS JOIN migration_cutoff
  WHERE determination.stage = 'finalized'
    AND determination.created_at < migration_cutoff.applied_at
    AND NOT EXISTS (
      SELECT 1
      FROM rework_responsibility_determinations successor
      WHERE successor.replaces_determination_id =
        determination.determination_id
    )
),
process_amounts AS (
  SELECT
    determination.determination_id,
    determination.rework_order_id,
    process.configuration_item_id,
    process.responsibility_amount original_process_total,
    round(
      COALESCE(sum(wage.payable_amount), 0) * process.multiplier,
      2
    ) settled_target_total
  FROM current_finalized determination
  JOIN rework_responsibility_processes process
    USING (determination_id)
  LEFT JOIN rework_wage_items wage
    ON wage.rework_order_id = determination.rework_order_id
   AND wage.configuration_item_id = process.configuration_item_id
  GROUP BY
    determination.determination_id,
    determination.rework_order_id,
    process.configuration_item_id,
    process.responsibility_amount,
    process.multiplier
),
eligible AS (
  SELECT
    process_amounts.*,
    settled_target_total - original_process_total adjustment_amount
  FROM process_amounts
  WHERE settled_target_total <> original_process_total
    AND abs(settled_target_total - original_process_total) <= 0.05
)
INSERT INTO rework_responsibility_rounding_adjustments (
  adjustment_id,
  determination_id,
  configuration_item_id,
  responsibility_type,
  adjustment_amount,
  original_process_total,
  settled_target_total,
  reason
)
SELECT
  gen_random_uuid(),
  eligible.determination_id,
  eligible.configuration_item_id,
  selected_allocation.responsibility_type,
  eligible.adjustment_amount,
  eligible.original_process_total,
  eligible.settled_target_total,
  '0047：校正 0045 迁移前判责与已结算工资之间的舍入尾差'
FROM eligible
JOIN LATERAL (
  SELECT allocation.responsibility_type
  FROM rework_responsibility_allocations allocation
  WHERE allocation.determination_id = eligible.determination_id
    AND allocation.configuration_item_id =
      eligible.configuration_item_id
  ORDER BY
    CASE WHEN allocation.responsibility_type = 'own_factory'
      THEN 0 ELSE 1 END,
    allocation.responsibility_type
  LIMIT 1
) selected_allocation ON true
ON CONFLICT (determination_id, configuration_item_id) DO NOTHING;
