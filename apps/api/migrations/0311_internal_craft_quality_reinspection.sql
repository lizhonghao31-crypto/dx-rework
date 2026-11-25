-- Reinspection appends evidence to the same QC ledger; the original problem
-- row and original rework remain immutable.
ALTER TABLE digital_factory_qc
  ADD COLUMN reinspection_rework_id uuid REFERENCES rework_orders(rework_order_id),
  ADD COLUMN supersedes_check_id uuid REFERENCES digital_factory_qc(check_id),
  ADD CONSTRAINT digital_factory_qc_exact_reinspection_source CHECK ((reinspection_rework_id IS NULL)=(supersedes_check_id IS NULL));
CREATE UNIQUE INDEX digital_factory_qc_one_pass_per_internal_rework
  ON digital_factory_qc(reinspection_rework_id) WHERE reinspection_rework_id IS NOT NULL;
CREATE UNIQUE INDEX digital_factory_qc_one_reinspection_per_scope
  ON digital_factory_qc(supersedes_check_id) WHERE supersedes_check_id IS NOT NULL;

CREATE FUNCTION guard_internal_craft_reinspection() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM rework_orders r JOIN digital_factory_qc original ON original.check_id=r.source_craft_qc_check_id
    WHERE r.rework_order_id=NEW.reinspection_rework_id AND r.craft_rework_execution='internal'
      AND r.status IN ('pending_order_review','pending_final_quantity_ie_review','pending_responsibility_determination',
       'pending_owner_signature','pending_responsibility_action','pending_quantity_adjustment_ie_review','completed')
      AND original.preparation_id=NEW.preparation_id AND original.return_fact_id=NEW.return_fact_id
      AND original.line_id=NEW.line_id AND original.check_id=NEW.supersedes_check_id AND original.quantity_scope IS NOT NULL
      AND original.result='需处理' AND NEW.quantity_scope IS NOT NULL
      AND NEW.quantity_scope->>'unit'='片' AND r.rework_quantity>0
      AND r.rework_quantity<=(original.quantity_scope->>'problemQuantity')::numeric
      AND (NEW.quantity_scope->>'inspectedQuantity')::numeric=(original.quantity_scope->>'inspectedQuantity')::numeric
      AND (NEW.quantity_scope->>'qualifiedQuantity')::numeric=(original.quantity_scope->>'qualifiedQuantity')::numeric+r.rework_quantity
      AND (NEW.quantity_scope->>'problemQuantity')::numeric=(original.quantity_scope->>'problemQuantity')::numeric-r.rework_quantity
      AND EXISTS(SELECT 1 FROM operation_events e WHERE e.entity_type='rework_order' AND e.entity_id=r.rework_order_id::text
        AND e.action IN ('rework.execution.complete','rework.work_report.submit','rework.tail_inspection.submit')
        AND e.after_state->>'status'='pending_order_review'
        AND (e.after_state->>'reworkQuantity')::numeric=r.rework_quantity)
  ) THEN RAISE EXCEPTION 'internal craft reinspection requires original completed work and exact QC quantities' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER digital_factory_qc_native_internal_reinspection BEFORE INSERT ON digital_factory_qc
 FOR EACH ROW WHEN (NEW.reinspection_rework_id IS NOT NULL) EXECUTE FUNCTION guard_internal_craft_reinspection();
