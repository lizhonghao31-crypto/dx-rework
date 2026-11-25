-- Source link on the original rework record, not a second rework ledger.
-- Earlier garment and independent rework records retain their original input.
ALTER TABLE rework_orders
  ADD COLUMN source_craft_qc_check_id uuid REFERENCES digital_factory_qc(check_id),
  ADD COLUMN craft_rework_execution text,
  ADD CONSTRAINT rework_original_craft_source_shape CHECK (
    (source_craft_qc_check_id IS NULL AND craft_rework_execution IS NULL)
    OR (source_craft_qc_check_id IS NOT NULL AND source_receiving_batch_id IS NULL
      AND rework_kind='qc_rework' AND craft_rework_execution IS NOT NULL
      AND craft_rework_execution IN ('internal','factory')
      AND rework_quantity IS NOT NULL AND rework_quantity>0)
  );

CREATE UNIQUE INDEX rework_current_craft_qc_source_idx
  ON rework_orders(source_craft_qc_check_id)
  WHERE source_craft_qc_check_id IS NOT NULL AND status NOT IN ('cancelled','deleted');

CREATE FUNCTION guard_rework_original_craft_quality_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  source_check digital_factory_qc%ROWTYPE;
  source_factory text;
BEGIN
  IF TG_OP='UPDATE' AND (NEW.source_craft_qc_check_id IS DISTINCT FROM OLD.source_craft_qc_check_id
    OR NEW.craft_rework_execution IS DISTINCT FROM OLD.craft_rework_execution) THEN
    RAISE EXCEPTION 'original craft rework source and execution kind cannot be replaced' USING ERRCODE='55000';
  END IF;
  IF NEW.source_craft_qc_check_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT * INTO source_check FROM digital_factory_qc WHERE check_id=NEW.source_craft_qc_check_id;
  IF NOT FOUND OR source_check.result<>'需处理' OR source_check.quantity_scope IS NULL
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
        AND q.line_id=source_check.line_id AND q.sequence>source_check.sequence) THEN
      RAISE EXCEPTION 'original craft check is no longer current' USING ERRCODE='55000';
    END IF;
    IF EXISTS (SELECT 1 FROM digital_factory_facts f JOIN rework_orders prior
      ON f.payload#>>'{warehouseMotion,reworkId}'=prior.rework_order_id::text
      WHERE f.preparation_id=source_check.preparation_id AND f.kind='工艺发出'
        AND prior.source_craft_qc_check_id=source_check.check_id AND prior.rework_order_id<>NEW.rework_order_id) THEN
      RAISE EXCEPTION 'the actual previous craft rework movement still occupies this source' USING ERRCODE='55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION craft_rework_has_original_report(source_id uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM digital_factory_qc q JOIN attachments a
      ON a.attachment_id=ANY(q.attachment_ids) AND a.entity_type='digital_factory_qc' AND a.entity_id=q.check_id::text
    WHERE q.check_id=source_id AND q.quantity_scope IS NOT NULL AND q.result='需处理'
      AND a.status='ready' AND a.mime_type IN ('image/jpeg','image/png','image/webp')
  )
$$;

-- A linked craft report remains attached to the original immutable QC. The
-- old image rule and the in-house finishing exception stay as before.
CREATE OR REPLACE FUNCTION guard_rework_submission_requires_image() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status='draft' AND NEW.status='pending_process_configuration'
     AND NEW.rework_kind='qc_rework'
     AND NOT craft_rework_has_original_report(NEW.source_craft_qc_check_id)
     AND NOT EXISTS (
       SELECT 1 FROM attachments attachment WHERE attachment.entity_type='rework_order'
         AND attachment.entity_id=NEW.rework_order_id::text AND attachment.status='ready'
         AND attachment.mime_type IN ('image/jpeg','image/png','image/webp')
     )
  THEN
    RAISE EXCEPTION 'N01 submission requires at least one ready rework image' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER rework_original_craft_quality_source_insert
  BEFORE INSERT ON rework_orders
  FOR EACH ROW WHEN (NEW.source_craft_qc_check_id IS NOT NULL OR NEW.craft_rework_execution IS NOT NULL)
  EXECUTE FUNCTION guard_rework_original_craft_quality_source();
CREATE TRIGGER rework_original_craft_quality_source_update
  BEFORE UPDATE ON rework_orders
  FOR EACH ROW WHEN (NEW.source_craft_qc_check_id IS NOT NULL OR OLD.source_craft_qc_check_id IS NOT NULL)
  EXECUTE FUNCTION guard_rework_original_craft_quality_source();

CREATE FUNCTION rework_original_quantity_bound(target_order_id uuid)
RETURNS TABLE(quantity numeric,unit text)
LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN orders.source_craft_qc_check_id IS NOT NULL THEN
    least(coalesce((check_row.quantity_scope->>'problemQuantity')::numeric,0), orders.rework_quantity)
    ELSE rework_source_receiving_actual_quantity(orders.rework_order_id) END,
    CASE WHEN orders.source_craft_qc_check_id IS NOT NULL THEN '片' ELSE '件' END
  FROM rework_orders orders
  LEFT JOIN digital_factory_qc check_row ON check_row.check_id=orders.source_craft_qc_check_id
  WHERE orders.rework_order_id=target_order_id AND orders.status<>'deleted'
$$;

-- Extend the original six downstream quantity guards. Their bindings and all
-- legacy receiving/unbound semantics remain unchanged.
CREATE OR REPLACE FUNCTION guard_rework_source_receiving_quantity_ceiling() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_order_id uuid;
  submitted_quantity numeric;
  source_ceiling numeric;
  source_unit text;
BEGIN
  CASE TG_TABLE_NAME
    WHEN 'rework_process_configuration_items' THEN
      SELECT configuration.rework_order_id INTO target_order_id
      FROM rework_process_configurations configuration WHERE configuration.configuration_id=NEW.configuration_id;
      submitted_quantity := NEW.planned_quantity;
    WHEN 'rework_process_quantity_adjustments' THEN
      target_order_id := NEW.rework_order_id;
      submitted_quantity := NEW.requested_planned_quantity;
    WHEN 'rework_work_reports' THEN
      target_order_id := NEW.rework_order_id;
      submitted_quantity := NEW.actual_quantity;
    WHEN 'rework_work_report_quantity_revisions' THEN
      target_order_id := NEW.rework_order_id;
      submitted_quantity := NEW.effective_quantity;
    WHEN 'rework_tail_inspection_reports' THEN
      target_order_id := NEW.rework_order_id;
      submitted_quantity := NEW.returned_quantity;
    WHEN 'rework_tail_completion_quantities' THEN
      SELECT confirmation.rework_order_id INTO target_order_id
      FROM rework_tail_completion_confirmations confirmation WHERE confirmation.confirmation_id=NEW.confirmation_id;
      submitted_quantity := greatest(NEW.worker_reported_quantity,NEW.tail_reported_quantity,NEW.final_confirmed_quantity);
    ELSE RAISE EXCEPTION 'unsupported receiving quantity ceiling table: %',TG_TABLE_NAME;
  END CASE;
  SELECT bound.quantity,bound.unit INTO source_ceiling,source_unit FROM rework_original_quantity_bound(target_order_id) bound;
  IF source_ceiling IS NOT NULL AND submitted_quantity>source_ceiling THEN
    IF source_unit='片' THEN
      RAISE EXCEPTION 'rework quantity exceeds source craft issue quantity ceiling %',source_ceiling USING ERRCODE='23514';
    END IF;
    RAISE EXCEPTION 'rework quantity exceeds source receiving actual quantity ceiling %',source_ceiling USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
