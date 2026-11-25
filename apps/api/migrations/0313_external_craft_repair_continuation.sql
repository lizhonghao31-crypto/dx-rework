-- Explicit continuation of one immutable original issue. Repeating the
-- initial command or the same predecessor can never allocate a second lot.
ALTER TABLE rework_orders
  ADD COLUMN craft_rework_after_id uuid REFERENCES rework_orders(rework_order_id),
  ADD CONSTRAINT rework_craft_continuation_shape CHECK (craft_rework_after_id IS NULL OR
    (source_craft_qc_check_id IS NOT NULL AND craft_rework_execution='factory' AND craft_rework_after_id<>rework_order_id));
DROP INDEX rework_current_craft_qc_source_idx;
CREATE UNIQUE INDEX rework_current_craft_qc_source_lot_idx ON rework_orders
  (source_craft_qc_check_id,(coalesce(craft_rework_after_id,'00000000-0000-0000-0000-000000000000'::uuid)))
  WHERE source_craft_qc_check_id IS NOT NULL AND status NOT IN ('cancelled','deleted');

CREATE FUNCTION craft_repair_can_continue(prior_id uuid,source_id uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS(SELECT 1 FROM rework_orders prior JOIN operation_events completion
      ON completion.entity_type='rework_order' AND completion.entity_id=prior.rework_order_id::text
      AND completion.action='rework.execution.complete'
    WHERE prior.rework_order_id=prior_id AND prior.source_craft_qc_check_id=source_id
      AND prior.craft_rework_execution='factory' AND prior.status NOT IN ('draft','cancelled','deleted','in_progress')
      AND original_external_craft_return_snapshot_matches(prior_id,completion.after_state->'externalRepair'))
$$;

-- Drafts reserve a command identity but never create a physical movement.
-- A cancelled case with a real old shipment cannot free those pieces.
CREATE FUNCTION craft_repair_unallocated(source_id uuid,excluded_id uuid) RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT greatest(0,(q.quantity_scope->>'problemQuantity')::numeric-coalesce((
    SELECT sum(r.rework_quantity) FROM rework_orders r WHERE r.source_craft_qc_check_id=q.check_id
      AND r.rework_order_id IS DISTINCT FROM excluded_id AND (r.status NOT IN ('cancelled','deleted') OR EXISTS(
        SELECT 1 FROM digital_factory_facts f WHERE f.preparation_id=q.preparation_id AND f.kind='工艺发出'
          AND f.payload#>>'{warehouseMotion,reworkId}'=r.rework_order_id::text
          AND f.payload#>>'{warehouseMotion,checkId}'=q.check_id::text))
  ),0)) FROM digital_factory_qc q WHERE q.check_id=source_id
$$;

CREATE OR REPLACE FUNCTION guard_rework_original_craft_quality_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  source_check digital_factory_qc%ROWTYPE;
  source_factory text;
BEGIN
  IF TG_OP='UPDATE' AND (NEW.source_craft_qc_check_id IS DISTINCT FROM OLD.source_craft_qc_check_id
    OR NEW.craft_rework_execution IS DISTINCT FROM OLD.craft_rework_execution
    OR NEW.craft_rework_after_id IS DISTINCT FROM OLD.craft_rework_after_id) THEN
    RAISE EXCEPTION 'original craft rework source and execution kind cannot be replaced' USING ERRCODE='55000';
  END IF;
  IF NEW.source_craft_qc_check_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT * INTO source_check FROM digital_factory_qc WHERE check_id=NEW.source_craft_qc_check_id FOR UPDATE;
  IF NOT FOUND OR source_check.result<>'需处理' OR source_check.quantity_scope IS NULL
    OR NEW.rework_quantity<>trunc(NEW.rework_quantity)
    OR NEW.rework_quantity>(source_check.quantity_scope->>'problemQuantity')::numeric THEN
    RAISE EXCEPTION 'rework quantity exceeds current craft problem scope' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' AND NEW.style_no IS DISTINCT FROM OLD.style_no THEN
    RAISE EXCEPTION 'the original craft issue style cannot be replaced' USING ERRCODE='55000';
  END IF;
  IF NEW.craft_rework_execution='factory' THEN
    SELECT f.payload#>>'{warehouseMotion,factoryId}' INTO source_factory FROM digital_factory_facts f
      WHERE f.preparation_id=source_check.preparation_id AND f.fact_id=source_check.return_fact_id AND f.kind='工艺回仓';
    IF source_factory IS NULL OR NEW.processing_factory_type IS DISTINCT FROM 'supplier'
      OR NEW.processing_factory_supplier_id::text IS DISTINCT FROM source_factory THEN
      RAISE EXCEPTION 'external craft repair must use the actual original factory' USING ERRCODE='23514';
    END IF;
  ELSIF NEW.processing_factory_type IS DISTINCT FROM 'own_factory' THEN
    RAISE EXCEPTION 'internal craft repair must use the original own-factory execution' USING ERRCODE='23514';
  END IF;
  IF (TG_OP='INSERT' OR (OLD.status='draft' AND NEW.status NOT IN ('draft','cancelled','deleted'))) THEN
    IF TG_OP='UPDATE' AND current_setting('dx_rework.craft_rework_check_id',true) IS DISTINCT FROM source_check.check_id::text THEN
      RAISE EXCEPTION 'craft rework submission requires current original QC verification' USING ERRCODE='55000';
    END IF;
    IF EXISTS (SELECT 1 FROM digital_factory_qc q
      WHERE q.preparation_id=source_check.preparation_id AND q.return_fact_id=source_check.return_fact_id
        AND q.line_id=source_check.line_id AND to_jsonb(q)->>'supersedes_check_id'=source_check.check_id::text) THEN
      RAISE EXCEPTION 'original craft check is no longer current' USING ERRCODE='55000';
    END IF;
    IF NEW.craft_rework_after_id IS NOT NULL AND NOT craft_repair_can_continue(NEW.craft_rework_after_id,source_check.check_id) THEN
      RAISE EXCEPTION 'continuation requires the exact prior external repair to finish' USING ERRCODE='23514';
    END IF;
  END IF;
  IF NEW.status NOT IN ('cancelled','deleted')
    AND NEW.rework_quantity>craft_repair_unallocated(source_check.check_id,NEW.rework_order_id) THEN
    RAISE EXCEPTION 'rework quantity exceeds unallocated original craft pieces' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
