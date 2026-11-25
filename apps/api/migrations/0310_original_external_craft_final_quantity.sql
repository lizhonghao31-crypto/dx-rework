-- Use the existing execution and final quantity audit. Do not create fake
-- worker/tail quantity lines or a second set of confirmation versions.
CREATE FUNCTION original_external_craft_return_snapshot_matches(target_id uuid, proof jsonb)
RETURNS boolean LANGUAGE sql STABLE AS $$
  WITH scope AS (
    SELECT r.rework_quantity, r.source_craft_qc_check_id, q.preparation_id, q.line_id,
      original.fact_id AS original_return_id, original.payload->>'stepRef' AS step_ref,
      r.processing_factory_supplier_id::text AS factory_id
    FROM rework_orders r
    JOIN digital_factory_qc q ON q.check_id=r.source_craft_qc_check_id AND q.result='需处理'
    JOIN digital_factory_facts original ON original.preparation_id=q.preparation_id
      AND original.fact_id=q.return_fact_id AND original.kind='工艺回仓'
    JOIN rework_process_configurations c ON c.rework_order_id=r.rework_order_id AND c.status='approved'
    JOIN rework_process_configuration_items item ON item.configuration_id=c.configuration_id
      AND item.execution_kind='external_craft' AND item.planned_quantity=r.rework_quantity
    WHERE r.rework_order_id=target_id AND r.craft_rework_execution='factory'
      AND NOT r.tail_inspection_required AND r.rework_quantity>0
      AND q.quantity_scope->>'unit'='片' AND r.rework_quantity<=(q.quantity_scope->>'problemQuantity')::numeric
      AND original.payload#>>'{warehouseMotion,factoryId}'=r.processing_factory_supplier_id::text
      AND NOT EXISTS(SELECT 1 FROM rework_process_configuration_items sibling
        WHERE sibling.configuration_id=c.configuration_id AND sibling.configuration_item_id<>item.configuration_item_id)
  ), motion AS (
    SELECT f.*, CASE WHEN jsonb_typeof(f.payload#>'{lines,0,quantity}')='number'
      THEN (f.payload#>>'{lines,0,quantity}')::numeric END AS quantity,
      (f.payload->>'stepRef'=s.step_ref AND f.payload#>>'{warehouseMotion,factoryId}'=s.factory_id
        AND f.payload#>>'{warehouseMotion,checkId}'=s.source_craft_qc_check_id::text
        AND CASE WHEN jsonb_typeof(f.payload->'lines')='array' THEN jsonb_array_length(f.payload->'lines')=1 ELSE false END
        AND f.payload#>>'{lines,0,lineId}'=s.line_id::text AND f.occurred_at IS NOT NULL) AS correct_scope
    FROM scope s JOIN digital_factory_facts f ON f.preparation_id=s.preparation_id
      AND f.payload#>>'{warehouseMotion,reworkId}'=target_id::text
  ), sent AS (
    SELECT m.* FROM motion m,scope s WHERE m.kind='工艺发出' AND m.payload->>'fromReturnId'=s.original_return_id::text
  ), returned AS (
    SELECT m.*, sent.fact_id AS original_send_id FROM motion m JOIN sent
      ON m.payload->>'sendFactId'=sent.fact_id::text AND m.sequence>sent.sequence AND m.occurred_at>=sent.occurred_at
    WHERE m.kind='工艺回仓'
  )
  SELECT EXISTS(SELECT 1 FROM scope s WHERE proof IS NOT NULL
    AND NOT EXISTS(SELECT 1 FROM motion m WHERE m.correct_scope IS NOT TRUE OR m.quantity IS NULL
      OR m.quantity<=0 OR m.quantity<>trunc(m.quantity))
    AND (SELECT count(*) FROM motion)=(SELECT count(*) FROM sent)+(SELECT count(*) FROM returned)
    AND (SELECT sum(quantity) FROM sent)=s.rework_quantity
    AND (SELECT sum(quantity) FROM returned)=s.rework_quantity
    AND NOT EXISTS(SELECT 1 FROM sent WHERE sent.quantity IS DISTINCT FROM
      (SELECT sum(quantity) FROM returned WHERE returned.original_send_id=sent.fact_id))
    AND proof->'requiredQuantity'=to_jsonb(s.rework_quantity) AND proof->'returnedQuantity'=to_jsonb(s.rework_quantity)
    AND (proof->>'physicalCompletedAt')::timestamptz=(SELECT date_trunc('milliseconds',max(occurred_at)) FROM returned)
    AND proof->'returnFactIds'=(SELECT jsonb_agg(fact_id ORDER BY sequence) FROM returned));
$$;

CREATE FUNCTION guard_original_external_craft_finish_facts() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE proof jsonb;
BEGIN
  SELECT after_state->'externalRepair' INTO proof FROM operation_events
  WHERE event_id=nullif(current_setting('dx_rework.rework_event_id',true),'')::uuid;
  IF NOT original_external_craft_return_snapshot_matches(OLD.rework_order_id,proof) THEN
    RAISE EXCEPTION 'outside craft execution requires complete original return evidence' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER rework_external_craft_original_finish_guard
  BEFORE UPDATE OF status ON rework_orders FOR EACH ROW WHEN (OLD.craft_rework_execution='factory'
    AND OLD.status='in_progress' AND NEW.status='pending_order_review')
  EXECUTE FUNCTION guard_original_external_craft_finish_facts();

CREATE FUNCTION guard_original_external_craft_confirmation_facts() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE proof jsonb;
BEGIN
  SELECT after_state->'externalRepair' INTO proof FROM operation_events WHERE event_id=NEW.operation_event_id;
  IF EXISTS(SELECT 1 FROM rework_orders WHERE rework_order_id=NEW.rework_order_id AND craft_rework_execution='factory') THEN
    IF NEW.price_snapshot_required OR NOT original_external_craft_return_snapshot_matches(NEW.rework_order_id,proof) THEN
      RAISE EXCEPTION 'outside craft final quantity requires original return evidence and no worker prices' USING ERRCODE='23514';
    END IF;
  ELSIF proof IS NOT NULL THEN
    RAISE EXCEPTION 'outside craft return evidence cannot substitute for original worker reports' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER rework_external_craft_original_confirmation_guard
  BEFORE INSERT ON rework_tail_completion_confirmations FOR EACH ROW
  EXECUTE FUNCTION guard_original_external_craft_confirmation_facts();

-- The 0129 normal worker audit still applies, including its actor, event,
-- version and old pending checks. Only the already verified pure-factory
-- branch is allowed not to supply a worker-price snapshot.
DO $migration$
DECLARE
  original_guard text;
  original_anchor constant text := 'IF NOT NEW.price_snapshot_required';
  external_path constant text := $path$IF (NOT NEW.price_snapshot_required AND NOT EXISTS (
    SELECT 1 FROM rework_orders target JOIN operation_events event ON event.event_id=NEW.operation_event_id
    WHERE target.rework_order_id=NEW.rework_order_id AND target.craft_rework_execution='factory'
      AND original_external_craft_return_snapshot_matches(target.rework_order_id,event.after_state->'externalRepair')
  ))$path$;
BEGIN
  SELECT p.prosrc INTO original_guard FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname=current_schema() AND p.proname='guard_rework_tail_completion_confirmation';
  IF original_guard IS NULL OR (length(original_guard)-length(replace(original_guard,original_anchor,'')))<>length(original_anchor) THEN
    RAISE EXCEPTION 'unexpected original N05 final quantity audit guard';
  END IF;
  EXECUTE format('CREATE OR REPLACE FUNCTION guard_rework_tail_completion_confirmation() RETURNS trigger LANGUAGE plpgsql AS %L',
    replace(original_guard,original_anchor,external_path));
END $migration$;

DO $migration$
DECLARE
  original_guard text;
  original_anchor constant text := 'AND item.unit_price IS NULL';
BEGIN
  SELECT p.prosrc INTO original_guard FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname=current_schema() AND p.proname='guard_rework_order_review_insert';
  IF original_guard IS NULL OR (length(original_guard)-length(replace(original_guard,original_anchor,'')))<>length(original_anchor) THEN
    RAISE EXCEPTION 'unexpected original N06 reviewed order audit guard';
  END IF;
  EXECUTE format('CREATE OR REPLACE FUNCTION guard_rework_order_review_insert() RETURNS trigger LANGUAGE plpgsql AS %L',
    replace(original_guard,original_anchor,original_anchor||' AND item.execution_kind<>''external_craft'''));
END $migration$;

-- Responsibility can reference the actual, non-wage operation even where
-- the charge base is zero. Keep existing allocation, amounts and approval
-- checks unchanged, including an external supplier selected by the handler.
DO $migration$
DECLARE
  original_guard text;
  original_anchor constant text := 'item.execution_kind = ''worker''';
BEGIN
  SELECT p.prosrc INTO original_guard FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname=current_schema() AND p.proname='validate_responsibility_version';
  IF original_guard IS NULL OR (length(original_guard)-length(replace(original_guard,original_anchor,'')))<>length(original_anchor) THEN
    RAISE EXCEPTION 'unexpected original responsibility version guard';
  END IF;
  EXECUTE format('CREATE OR REPLACE FUNCTION validate_responsibility_version(version_id uuid) RETURNS void LANGUAGE plpgsql AS %L',
    replace(original_guard,original_anchor,'('||original_anchor||' OR (item.execution_kind=''external_craft'' AND target_order.craft_rework_execution=''factory''))'));
END $migration$;
