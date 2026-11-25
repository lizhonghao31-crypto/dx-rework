-- Original N02 configuration, with an actual non-worker process for the
-- pure external branch. Legacy worker and inspection rows cannot opt in.
ALTER TABLE rework_process_configuration_items
  DROP CONSTRAINT rework_process_configuration_items_execution_kind_check,
  ADD CONSTRAINT rework_process_configuration_items_execution_kind_check
    CHECK (execution_kind IN ('worker','tail_inspection','external_craft')),
  ADD CONSTRAINT rework_external_craft_non_worker_item
    CHECK (execution_kind<>'external_craft' OR
      (source='custom' AND pricing_unit='piece' AND unit_price IS NULL AND special_process_type IS NULL));
ALTER TABLE rework_process_configuration_items
  DROP CONSTRAINT rework_process_item_unit_price_required_check,
  ADD CONSTRAINT rework_process_item_unit_price_required_check
    CHECK (CASE WHEN execution_kind='external_craft' THEN unit_price IS NULL
      ELSE unit_price IS NOT NULL AND unit_price>=0.001 AND unit_price=trunc(unit_price,3) END) NOT VALID;

CREATE FUNCTION original_external_craft_configuration_matches(oid uuid,cid uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS(
    SELECT 1 FROM rework_orders orders
    JOIN rework_process_configurations config ON config.rework_order_id=orders.rework_order_id
    JOIN rework_process_configuration_items item ON item.configuration_id=config.configuration_id
    WHERE orders.rework_order_id=oid AND config.configuration_id=cid
      AND orders.craft_rework_execution='factory' AND orders.source_craft_qc_check_id IS NOT NULL
      AND orders.status='pending_process_configuration' AND NOT orders.tail_inspection_required
      AND config.configuration_kind='initial' AND NOT config.worker_preassignment_required
      AND config.unified_execution_required AND item.execution_kind='external_craft'
      AND item.planned_quantity=orders.rework_quantity
      AND NOT EXISTS(SELECT 1 FROM rework_process_configuration_items sibling
        WHERE sibling.configuration_id=cid AND sibling.configuration_item_id<>item.configuration_item_id)
  )
$$;

-- Extend only exact original transition anchors. Normal N02/N03, approvals
-- and all role/audit checks outside the new source mode remain byte-for-byte.
DO $migration$
DECLARE
  original_guard text;
  original_anchor constant text := 'IF OLD.status=''draft'' AND NEW.status=''pending_ie_review'' THEN';
  external_path constant text := $path$IF OLD.status='draft' AND NEW.status='approved'
      AND NEW.submitted_at IS NOT NULL AND NEW.reviewed_at IS NOT NULL AND NEW.reviewed_by=NEW.created_by
      AND original_external_craft_configuration_matches(NEW.rework_order_id,NEW.configuration_id) THEN
      expected_action := 'rework.process_configuration.external_activate';
      expected_capability := 'process:configure';
    ELSIF OLD.status='draft' AND NEW.status='pending_ie_review' THEN$path$;
BEGIN
  SELECT p.prosrc INTO original_guard FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname=current_schema() AND p.proname='guard_rework_process_configuration_write';
  IF original_guard IS NULL OR (length(original_guard)-length(replace(original_guard,original_anchor,'')))<>length(original_anchor) THEN
    RAISE EXCEPTION 'unexpected original process configuration transition guard';
  END IF;
  EXECUTE format('CREATE OR REPLACE FUNCTION guard_rework_process_configuration_write() RETURNS trigger LANGUAGE plpgsql AS %L',
    replace(original_guard,original_anchor,external_path));
END $migration$;

DO $migration$
DECLARE
  original_guard text;
  original_anchor constant text := 'ELSIF OLD.status=''pending_process_configuration'' AND NEW.status=''draft'' THEN';
  external_path constant text := $path$ELSIF OLD.status='pending_process_configuration' AND NEW.status='in_progress'
      AND OLD.craft_rework_execution='factory' AND OLD.source_craft_qc_check_id IS NOT NULL
      AND (to_jsonb(NEW)-ARRAY['status','updated_at','updated_by','version'])=(to_jsonb(OLD)-ARRAY['status','updated_at','updated_by','version'])
      AND EXISTS(SELECT 1 FROM rework_process_configurations configuration
        WHERE configuration.rework_order_id=NEW.rework_order_id AND configuration.status='approved'
          AND original_external_craft_configuration_matches(NEW.rework_order_id,configuration.configuration_id)) THEN
      expected_action:='rework.process_configuration.external_activate'; expected_capability:='process:configure';
      ELSIF OLD.status='pending_process_configuration' AND NEW.status='draft' THEN$path$;
BEGIN
  SELECT p.prosrc INTO original_guard FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname=current_schema() AND p.proname='guard_rework_order_write';
  IF original_guard IS NULL OR (length(original_guard)-length(replace(original_guard,original_anchor,'')))<>length(original_anchor) THEN
    RAISE EXCEPTION 'unexpected original rework order transition guard';
  END IF;
  EXECUTE format('CREATE OR REPLACE FUNCTION guard_rework_order_write() RETURNS trigger LANGUAGE plpgsql AS %L',
    replace(original_guard,original_anchor,external_path));
END $migration$;

CREATE FUNCTION guard_original_external_craft_worker_task() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM rework_process_configuration_items item
    WHERE item.configuration_item_id=NEW.configuration_item_id AND item.execution_kind='external_craft') THEN
    RAISE EXCEPTION 'external craft execution cannot create a worker task' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER rework_external_craft_worker_task_guard
  BEFORE INSERT ON rework_work_tasks FOR EACH ROW EXECUTE FUNCTION guard_original_external_craft_worker_task();

CREATE FUNCTION guard_original_external_craft_item() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM rework_process_configurations c JOIN rework_orders r USING(rework_order_id)
    WHERE c.configuration_id=NEW.configuration_id AND c.status='draft' AND c.configuration_kind='initial'
      AND NOT c.worker_preassignment_required AND c.unified_execution_required AND r.craft_rework_execution='factory'
      AND r.status='pending_process_configuration' AND NOT r.tail_inspection_required AND r.rework_quantity=NEW.planned_quantity) THEN
    RAISE EXCEPTION 'external configuration item requires the original pure-factory source' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER rework_external_craft_item_guard
  BEFORE INSERT ON rework_process_configuration_items FOR EACH ROW WHEN (NEW.execution_kind='external_craft')
  EXECUTE FUNCTION guard_original_external_craft_item();
