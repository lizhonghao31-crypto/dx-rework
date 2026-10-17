-- No backfill: NULL remains the legacy-order eligibility boundary.
ALTER TABLE rework_orders
  ADD COLUMN special_process_type text,
  ADD COLUMN other_craft_description text,
  ADD CONSTRAINT rework_special_process_check CHECK (
    CASE WHEN special_process_type IS NULL THEN other_craft_description IS NULL
    ELSE (rework_kind='qc_rework' AND special_process_type IN ('none','inspection','other_craft')
      AND tail_inspection_required=(special_process_type<>'none')
      AND (CASE WHEN special_process_type='other_craft' THEN
        (other_craft_description IS NULL OR
          (other_craft_description=btrim(other_craft_description)
            AND length(other_craft_description) BETWEEN 1 AND 100))
        AND (status IN ('draft','cancelled','deleted') OR other_craft_description IS NOT NULL)
      ELSE other_craft_description IS NULL END)) END
  );

CREATE FUNCTION guard_rework_special_process() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE event operation_events%ROWTYPE; changed boolean;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF OLD.special_process_type IS NULL AND NEW.special_process_type IS NOT NULL THEN
      RAISE EXCEPTION 'legacy rework orders cannot opt into other craft' USING ERRCODE='23514';
    END IF;
    IF OLD.special_process_type IS NOT NULL AND NEW.special_process_type IS NULL THEN
      RAISE EXCEPTION 'new order eligibility cannot be erased' USING ERRCODE='23514';
    END IF;
    changed := NEW.special_process_type IS DISTINCT FROM OLD.special_process_type
      OR NEW.other_craft_description IS DISTINCT FROM OLD.other_craft_description;
    IF NOT changed THEN RETURN NEW; END IF;
  ELSIF NEW.special_process_type IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT * INTO event FROM operation_events
  WHERE event_id=nullif(current_setting('dx_rework.rework_event_id',true),'')::uuid
    AND request_id=current_setting('dx_rework.rework_request_id',true)
    AND entity_type='rework_order' AND entity_id=NEW.rework_order_id::text;
  IF NOT FOUND OR NOT (event.after_state @> jsonb_build_object(
    'specialProcessType',NEW.special_process_type,'otherCraftDescription',NEW.other_craft_description)) THEN
    RAISE EXCEPTION 'special process requires matching audit snapshot' USING ERRCODE='55000';
  END IF;
  IF TG_OP='INSERT' THEN
    IF event.action<>'rework.draft.create' OR NEW.source_system<>'manual' THEN
      RAISE EXCEPTION 'other craft starts in a new QC draft' USING ERRCODE='55000';
    END IF;
  ELSIF NOT (
    (OLD.status='draft' AND NEW.status='draft' AND event.action='rework.draft.update')
    OR (event.action='rework.tail_inspection.waive' AND NEW.special_process_type='none'
      AND NEW.other_craft_description IS NULL)
  ) THEN
    RAISE EXCEPTION 'special process can only change in draft or audited waiver' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER rework_special_process_guard
  BEFORE INSERT OR UPDATE ON rework_orders
  FOR EACH ROW EXECUTE FUNCTION guard_rework_special_process();

-- Waiver already limits mutable fields. Include only the two retired metadata
-- fields; the independent guard above still requires the matching audit event.
DO $migration$
DECLARE guard_source text;
  old_fields constant text := 'ARRAY[''status'',''tail_inspection_required'',''tail_inspection_cost_bearer'',''tail_inspection_cost_bearer_source'',''updated_by'',''version'',''updated_at'']';
  new_fields constant text := 'ARRAY[''status'',''tail_inspection_required'',''tail_inspection_cost_bearer'',''tail_inspection_cost_bearer_source'',''special_process_type'',''other_craft_description'',''updated_by'',''version'',''updated_at'']';
BEGIN
  SELECT proc.prosrc INTO guard_source FROM pg_proc proc JOIN pg_namespace ns ON ns.oid=proc.pronamespace
  WHERE ns.nspname=current_schema() AND proc.proname='guard_rework_order_write'
    AND pg_get_function_identity_arguments(proc.oid)='';
  IF guard_source IS NULL OR (length(guard_source)-length(replace(guard_source,old_fields,'')))/length(old_fields)<>2 THEN
    RAISE EXCEPTION 'unexpected special process waiver guard shape';
  END IF;
  EXECUTE format('CREATE OR REPLACE FUNCTION guard_rework_order_write() RETURNS trigger LANGUAGE plpgsql AS %L',replace(guard_source,old_fields,new_fields));
END $migration$;

-- The immutable configuration item retains the business type/name after waiver.
ALTER TABLE rework_process_configuration_items
  ADD COLUMN special_process_type text CHECK (special_process_type IN ('inspection','other_craft')),
  DROP CONSTRAINT rework_process_configuration_items_process_name_check,
  ADD CONSTRAINT rework_process_item_name_check CHECK (
    CASE WHEN special_process_type='other_craft' THEN
      execution_kind='tail_inspection' AND source='custom'
      AND length(btrim(custom_process_name)) BETWEEN 1 AND 100
      AND process_name='其他工艺：'||custom_process_name
    ELSE length(btrim(process_name)) BETWEEN 1 AND 100 END
  );

CREATE FUNCTION guard_rework_special_process_item() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE mode text; description text;
BEGIN
  SELECT orders.special_process_type,orders.other_craft_description INTO mode,description
  FROM rework_orders orders JOIN rework_process_configurations configuration USING(rework_order_id)
  WHERE configuration.configuration_id=NEW.configuration_id;
  IF NEW.execution_kind='tail_inspection' THEN
    IF NEW.special_process_type IS DISTINCT FROM nullif(mode,'none')
      OR (mode='other_craft' AND (description IS NULL
        OR NEW.custom_process_name IS DISTINCT FROM description
        OR NEW.process_name IS DISTINCT FROM '其他工艺：'||description)) THEN
      RAISE EXCEPTION 'special process item must match the submitted order' USING ERRCODE='23514';
    END IF;
  ELSIF NEW.special_process_type IS NOT NULL THEN
    RAISE EXCEPTION 'ordinary process cannot carry a special process type' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER rework_special_process_item_guard
  BEFORE INSERT ON rework_process_configuration_items
  FOR EACH ROW EXECUTE FUNCTION guard_rework_special_process_item();
