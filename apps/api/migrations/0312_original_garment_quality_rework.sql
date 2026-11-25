ALTER TABLE rework_orders
  ADD COLUMN source_garment_qc_event_id uuid REFERENCES digital_production_task_events(event_id),
  ADD CONSTRAINT rework_garment_quality_receipt_scope CHECK (
    source_garment_qc_event_id IS NULL OR
    (rework_kind='qc_rework' AND source_receiving_batch_id IS NOT NULL AND source_craft_qc_check_id IS NULL)
  );

CREATE FUNCTION original_garment_qc_problem_quantity(check_id uuid, batch_id uuid, require_current boolean)
RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT (e.payload->>'quantity')::numeric - (e.payload->>'qualifiedQuantity')::numeric
    FROM digital_production_task_events e
    JOIN digital_production_child_lines scope ON scope.production_order_id=e.resource_id AND scope.module='receiving'
    JOIN receiving_receipts receipt ON receipt.receipt_id=scope.child_id AND receipt.receipt_id::text=e.payload->>'receiptId'
    JOIN receiving_batches batch ON batch.receiving_batch_id=receipt.receiving_batch_id
    LEFT JOIN LATERAL (
      SELECT latest.correction_id,latest.actual_quantity FROM receiving_receipt_corrections latest
      WHERE latest.receipt_id=receipt.receipt_id ORDER BY latest.created_at DESC,latest.correction_id DESC LIMIT 1
    ) correction ON true
   WHERE e.event_id=check_id AND e.event_kind='garment_receipt_qc' AND e.resource_kind='order'
     AND batch.receiving_batch_id=batch_id
     AND jsonb_typeof(e.payload->'quantity')='number' AND jsonb_typeof(e.payload->'qualifiedQuantity')='number'
     AND (e.payload->>'qualifiedQuantity')::numeric>=0
     AND (e.payload->>'quantity')::numeric>(e.payload->>'qualifiedQuantity')::numeric
     AND btrim(e.payload->>'problem')<>''
     AND (NOT require_current OR (
       batch.deleted_at IS NULL
       AND NOT EXISTS(SELECT 1 FROM digital_order_closures closed WHERE closed.production_order_id=e.resource_id)
       AND NOT EXISTS(SELECT 1 FROM digital_production_resource_lifecycle stopped WHERE stopped.state<>'active' AND
         (stopped.resource_kind='order' AND stopped.resource_id=e.resource_id OR stopped.resource_kind='source' AND
          stopped.resource_id=(SELECT o.source_id FROM digital_production_orders o WHERE o.production_order_id=e.resource_id)))
       AND e.payload->>'quantityVersion'=coalesce(correction.correction_id,receipt.receipt_id)::text
       AND e.payload->'quantity'=to_jsonb(coalesce(correction.actual_quantity,receipt.actual_quantity)::bigint)
       AND NOT EXISTS (SELECT 1 FROM digital_production_task_events later
         WHERE later.resource_kind='order' AND later.resource_id=e.resource_id AND later.event_kind=e.event_kind
           AND later.payload->>'receiptId'=e.payload->>'receiptId'
           AND (later.recorded_at,later.event_id)>(e.recorded_at,e.event_id))
     ))
   GROUP BY e.event_id
  HAVING count(*)=1
$$;

CREATE FUNCTION guard_original_garment_quality_rework() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE bound numeric;
DECLARE require_current boolean;
BEGIN
  IF TG_OP='UPDATE' AND (NEW.source_garment_qc_event_id IS DISTINCT FROM OLD.source_garment_qc_event_id
    OR NEW.source_receiving_batch_id IS DISTINCT FROM OLD.source_receiving_batch_id) THEN
    RAISE EXCEPTION 'original garment quality source is immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.status IN ('cancelled','deleted') THEN RETURN NEW; END IF;
  require_current := TG_OP='INSERT' OR (OLD.status='draft' AND NEW.status<>'draft');
  IF require_current THEN
    PERFORM 1 FROM receiving_batches WHERE receiving_batch_id=NEW.source_receiving_batch_id FOR SHARE;
  END IF;
  bound := original_garment_qc_problem_quantity(NEW.source_garment_qc_event_id,NEW.source_receiving_batch_id,require_current);
  IF bound IS NULL THEN
    RAISE EXCEPTION 'original garment quality source is missing or outdated' USING ERRCODE='23514';
  END IF;
  IF NEW.rework_quantity IS NULL OR NEW.rework_quantity<1 OR NEW.rework_quantity>bound THEN
    RAISE EXCEPTION 'rework quantity exceeds source garment QC issue quantity ceiling %',bound USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER rework_original_garment_quality_insert
  BEFORE INSERT ON rework_orders FOR EACH ROW WHEN (NEW.source_garment_qc_event_id IS NOT NULL)
  EXECUTE FUNCTION guard_original_garment_quality_rework();
CREATE TRIGGER rework_original_garment_quality_update
  BEFORE UPDATE ON rework_orders FOR EACH ROW WHEN (OLD.source_garment_qc_event_id IS NOT NULL OR NEW.source_garment_qc_event_id IS NOT NULL)
  EXECUTE FUNCTION guard_original_garment_quality_rework();

CREATE OR REPLACE FUNCTION rework_original_quantity_bound(target_order_id uuid)
RETURNS TABLE(quantity numeric,unit text) LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN orders.source_craft_qc_check_id IS NOT NULL THEN
    least(coalesce((check_row.quantity_scope->>'problemQuantity')::numeric,0),orders.rework_quantity)
    WHEN orders.source_garment_qc_event_id IS NOT NULL THEN
    least(coalesce(original_garment_qc_problem_quantity(orders.source_garment_qc_event_id,orders.source_receiving_batch_id,false),0),
      orders.rework_quantity,rework_source_receiving_actual_quantity(orders.rework_order_id))
    ELSE rework_source_receiving_actual_quantity(orders.rework_order_id) END,
    CASE WHEN orders.source_craft_qc_check_id IS NOT NULL THEN '片' ELSE '件' END
  FROM rework_orders orders
  LEFT JOIN digital_factory_qc check_row ON check_row.check_id=orders.source_craft_qc_check_id
  WHERE orders.rework_order_id=target_order_id AND orders.status<>'deleted'
$$;
