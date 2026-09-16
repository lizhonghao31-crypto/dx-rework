-- 2026-09-16: all order merchandisers handle both differences; warehouse records facts.
-- Already-recorded quantities may only be corrected by Root. Historical records stay immutable.
ALTER TABLE role_capabilities DISABLE TRIGGER role_capabilities_no_insert;
ALTER TABLE role_capabilities DISABLE TRIGGER role_capabilities_no_delete;
ALTER TABLE capability_catalog DISABLE TRIGGER capability_catalog_no_update;
DELETE FROM role_capabilities WHERE capability='receiving:resolve_difference' AND role_code='warehouse_receiver';
DELETE FROM role_capabilities WHERE capability='receiving:packing_manage' AND role_code='tail_supervisor';
INSERT INTO role_capabilities(role_code,capability) VALUES
 ('order_merchandiser','receiving:resolve_difference'),('warehouse_receiver','receiving:packing_manage')
ON CONFLICT DO NOTHING;
UPDATE capability_catalog SET display_name='处理收货与装箱差异',description='所有订单跟单记录两类差异处理结果，不修改原数量' WHERE capability='receiving:resolve_difference';
UPDATE capability_catalog SET display_name='录入装箱数量',description='仓管首次录入装箱数量，已录数量仅Root可修改' WHERE capability='receiving:packing_manage';
ALTER TABLE capability_catalog ENABLE TRIGGER capability_catalog_no_update;
ALTER TABLE role_capabilities ENABLE TRIGGER role_capabilities_no_delete;
ALTER TABLE role_capabilities ENABLE TRIGGER role_capabilities_no_insert;

CREATE FUNCTION receiving_authorized_board_operator(actor_id uuid,requested_capability text)
RETURNS text[] LANGUAGE plpgsql STABLE AS $$
DECLARE actual_roles text[]; required_role text;
BEGIN
 actual_roles:=access_authorized_actor_roles(actor_id,requested_capability);
 IF 'root_superuser'=ANY(actual_roles) THEN RETURN actual_roles; END IF;
 required_role:=CASE requested_capability WHEN 'receiving:resolve_difference' THEN 'order_merchandiser'
   WHEN 'receiving:packing_manage' THEN 'warehouse_receiver' ELSE NULL END;
 IF required_role IS NULL OR NOT required_role=ANY(actual_roles) THEN
   RAISE EXCEPTION 'receiving board operation forbidden' USING ERRCODE='42501';
 END IF;
 RETURN actual_roles;
END $$;

CREATE OR REPLACE FUNCTION guard_receiving_packing_revision_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE event_record operation_events%ROWTYPE; actual_roles text[]; style_key text;
BEGIN
  actual_roles:=receiving_authorized_board_operator(NEW.recorded_by,'receiving:packing_manage');
  SELECT upper(btrim(style_no)) INTO style_key FROM receiving_batches WHERE receiving_batch_id=NEW.receiving_batch_id AND deleted_at IS NULL;
  PERFORM pg_advisory_xact_lock(hashtext(style_key));
  IF NOT 'root_superuser'=ANY(actual_roles) AND EXISTS (
    SELECT 1 FROM receiving_packing_revisions revision JOIN receiving_batches batch USING(receiving_batch_id)
    WHERE upper(btrim(batch.style_no))=style_key AND batch.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'only Root may correct recorded packing quantity' USING ERRCODE='42501';
  END IF;
  SELECT * INTO event_record FROM operation_events event
  WHERE event.event_id=NEW.operation_event_id
    AND event.request_id=NEW.request_id
    AND event.actor_id=NEW.recorded_by
    AND event.authorization_capability='receiving:packing_manage'
    AND event.action='receiving.packing.record'
    AND event.entity_type='receiving_batch'
    AND event.entity_id=NEW.receiving_batch_id::text;
  IF event_record.event_id IS NULL
     OR (event_record.after_state->>'packingRevisionId')::uuid IS DISTINCT FROM NEW.packing_revision_id
     OR (event_record.after_state->>'packingQuantity')::bigint IS DISTINCT FROM NEW.packing_quantity
  THEN
    RAISE EXCEPTION 'packing revision requires matching trusted event' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION guard_receiving_difference_resolution_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE event_record operation_events%ROWTYPE; expected_capability text;
BEGIN
  expected_capability:='receiving:resolve_difference';
  PERFORM receiving_authorized_board_operator(NEW.handled_by,expected_capability);
  SELECT * INTO event_record FROM operation_events event
  WHERE event.event_id=NEW.operation_event_id
    AND event.request_id=NEW.request_id
    AND event.actor_id=NEW.handled_by
    AND event.authorization_capability=expected_capability
    AND event.action='receiving.difference.resolve'
    AND event.entity_type='receiving_batch'
    AND event.entity_id=NEW.receiving_batch_id::text;
  IF event_record.event_id IS NULL
     OR event_record.after_state->>'differenceType' IS DISTINCT FROM NEW.difference_type
     OR (event_record.after_state->>'resolutionId')::uuid IS DISTINCT FROM NEW.resolution_id
     OR (event_record.after_state->>'documentQuantity')::bigint IS DISTINCT FROM NEW.document_quantity_snapshot
     OR (event_record.after_state->>'actualQuantity')::bigint IS DISTINCT FROM NEW.actual_quantity_snapshot
     OR (event_record.after_state->>'packingRevisionId')::uuid IS DISTINCT FROM NEW.packing_revision_id
     OR (event_record.after_state->>'packingQuantity')::bigint IS DISTINCT FROM NEW.packing_quantity_snapshot
     OR (event_record.after_state->>'differenceQuantity')::bigint IS DISTINCT FROM NEW.difference_quantity_snapshot
     OR event_record.after_state->>'result' IS DISTINCT FROM NEW.result
  THEN
    RAISE EXCEPTION 'difference resolution requires matching trusted event' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;
