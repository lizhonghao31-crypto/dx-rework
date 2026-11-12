-- A business tombstone, not a physical purge. Native facts and durable links
-- remain intact; readers/writers consult the exact immutable object scope.
CREATE TABLE digital_whole_order_deletions (
 deletion_id uuid PRIMARY KEY,
 source_id uuid UNIQUE REFERENCES digital_production_sources(source_id),
 production_order_id uuid UNIQUE REFERENCES digital_production_orders(production_order_id),
 actor_id uuid NOT NULL REFERENCES app_users(id),
 operation_event_id uuid NOT NULL REFERENCES operation_events(event_id),
 request_id text NOT NULL,
 idempotency_key text NOT NULL,
 preview_revision text NOT NULL CHECK(length(preview_revision)=64),
 scope_json jsonb NOT NULL,
 deleted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(source_id IS NOT NULL OR production_order_id IS NOT NULL)
);
CREATE TABLE digital_whole_order_deleted_objects (
 object_kind text NOT NULL,
 object_id uuid NOT NULL,
 deletion_id uuid NOT NULL REFERENCES digital_whole_order_deletions(deletion_id),
 PRIMARY KEY(object_kind,object_id)
);
CREATE INDEX digital_whole_order_deleted_objects_deletion ON digital_whole_order_deleted_objects(deletion_id);
CREATE TRIGGER digital_whole_order_deletions_immutable BEFORE UPDATE OR DELETE ON digital_whole_order_deletions FOR EACH ROW EXECUTE FUNCTION guard_production_order_root_immutable();
CREATE TRIGGER digital_whole_order_deleted_objects_immutable BEFORE UPDATE OR DELETE ON digital_whole_order_deleted_objects FOR EACH ROW EXECUTE FUNCTION guard_production_order_root_immutable();

CREATE FUNCTION digital_whole_order_active(kind text,id uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
 SELECT NOT EXISTS(SELECT 1 FROM digital_whole_order_deleted_objects d WHERE d.object_kind=kind AND d.object_id=id)
$$;

CREATE FUNCTION guard_whole_order_deletion_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT access_is_root_actor(NEW.actor_id) OR NOT EXISTS(
  SELECT 1 FROM operation_events e WHERE e.event_id=NEW.operation_event_id AND e.actor_id=NEW.actor_id
   AND e.request_id=NEW.request_id AND e.action='digital.whole_order.delete'
   AND e.actor_roles @> ARRAY['root_superuser']::text[]
   AND e.after_state->>'deletionId'=NEW.deletion_id::text
   AND e.after_state->>'revision'=NEW.preview_revision
 ) THEN RAISE EXCEPTION 'whole order deletion requires current Root and matching audit' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER whole_order_deletion_audit BEFORE INSERT ON digital_whole_order_deletions
 FOR EACH ROW EXECUTE FUNCTION guard_whole_order_deletion_insert();
CREATE FUNCTION guard_whole_order_deleted_object() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM digital_whole_order_deletions d,
  jsonb_to_recordset(d.scope_json->'objects') AS o(kind text,id uuid)
  WHERE d.deletion_id=NEW.deletion_id AND o.kind=NEW.object_kind AND o.id=NEW.object_id
 ) THEN RAISE EXCEPTION 'deleted object must belong to confirmed whole order scope' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER whole_order_deleted_object_scope BEFORE INSERT ON digital_whole_order_deleted_objects
 FOR EACH ROW EXECUTE FUNCTION guard_whole_order_deleted_object();

-- Preserve the standalone receiving guard. Only this same audited whole-order
-- transaction, after its own reworks are deleted, may close the owned batch.
CREATE OR REPLACE FUNCTION guard_receiving_batch_root_update()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  event_record operation_events%ROWTYPE;
  action_name text:=nullif(current_setting('dx_rework.receiving_root_action',true),'');
  delivery_increment bigint;
BEGIN
  IF OLD.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'deleted receiving batch is immutable' USING ERRCODE='55000'; END IF;
  IF NEW.receiving_batch_id IS DISTINCT FROM OLD.receiving_batch_id
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.version<>OLD.version+1 OR NEW.updated_at<=OLD.updated_at
     OR NEW.updated_by IS NULL OR NEW.last_operation_event_id IS NULL OR NEW.last_request_id IS NULL
  THEN RAISE EXCEPTION 'invalid receiving batch correction shape' USING ERRCODE='23514'; END IF;

  IF action_name='append_other_factory' THEN
    SELECT * INTO event_record FROM operation_events event
    WHERE event.event_id=NEW.last_operation_event_id AND event.request_id=NEW.last_request_id
      AND event.actor_id=NEW.updated_by AND event.authorization_capability='receiving:create'
      AND event.action='receiving.receipt.create' AND event.entity_type='receiving_receipt'
      AND event.after_state->>'receivingBatchId'=NEW.receiving_batch_id::text
      AND event.after_state->>'receivingSource'='other_factory';
    IF event_record.event_id IS NULL
       OR COALESCE(event_record.after_state->>'deliveryNoteIncrement','') !~ '^[1-9][0-9]*$'
    THEN RAISE EXCEPTION 'other factory delivery-note update requires matching trusted receiving event' USING ERRCODE='55000'; END IF;
    delivery_increment:=(event_record.after_state->>'deliveryNoteIncrement')::bigint;
    IF NEW.style_no IS DISTINCT FROM OLD.style_no
       OR NEW.document_quantity_adjustment<>OLD.document_quantity_adjustment
       OR NEW.actual_quantity_adjustment<>OLD.actual_quantity_adjustment
       OR NEW.defective_quantity_adjustment<>OLD.defective_quantity_adjustment
       OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at
       OR NEW.deleted_by IS DISTINCT FROM OLD.deleted_by
       OR NEW.delivery_note_quantity IS DISTINCT FROM OLD.delivery_note_quantity+delivery_increment
    THEN RAISE EXCEPTION 'other factory delivery-note update does not match receiving event' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;

  IF action_name NOT IN ('correct','merge')
     AND EXISTS(SELECT 1 FROM rework_orders rework WHERE rework.source_receiving_batch_id=OLD.receiving_batch_id)
     AND NOT (action_name='delete' AND EXISTS(
       SELECT 1 FROM digital_whole_order_deleted_objects b
       JOIN digital_whole_order_deletions d USING(deletion_id)
       WHERE b.object_kind='receiving_batch' AND b.object_id=OLD.receiving_batch_id
        AND d.actor_id=NEW.updated_by AND d.request_id=NEW.last_request_id
        AND NOT EXISTS(SELECT 1 FROM rework_orders r WHERE r.source_receiving_batch_id=OLD.receiving_batch_id
          AND (r.status<>'deleted' OR NOT EXISTS(SELECT 1 FROM digital_whole_order_deleted_objects ro
            WHERE ro.object_kind='rework' AND ro.object_id=r.rework_order_id AND ro.deletion_id=d.deletion_id)))
     ))
  THEN RAISE EXCEPTION 'receiving batch is locked after rework initiation' USING ERRCODE='55000'; END IF;
  SELECT * INTO event_record FROM operation_events event
  WHERE event.event_id=NEW.last_operation_event_id AND event.request_id=NEW.last_request_id
    AND event.actor_id=NEW.updated_by AND event.authorization_capability='receiving:correct'
    AND event.actor_roles @> ARRAY['root_superuser']::text[]
    AND event.entity_type='receiving_batch' AND event.entity_id=NEW.receiving_batch_id::text;
  IF event_record.event_id IS NULL THEN RAISE EXCEPTION 'receiving batch change requires trusted root audit event' USING ERRCODE='55000'; END IF;

  IF action_name IN ('correct','merge') THEN
    IF event_record.action<>(CASE WHEN action_name='merge' THEN 'receiving.batch.merge' ELSE 'receiving.batch.correct' END)
       OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at OR NEW.deleted_by IS DISTINCT FROM OLD.deleted_by
       OR (NEW.document_quantity_adjustment+(SELECT COALESCE(sum(document_quantity),0) FROM receiving_receipts WHERE receiving_batch_id=NEW.receiving_batch_id))<=0
       OR (NEW.actual_quantity_adjustment+(SELECT COALESCE(sum(actual_quantity),0) FROM receiving_receipts WHERE receiving_batch_id=NEW.receiving_batch_id))<0
       OR event_record.after_state->>'styleNo' IS DISTINCT FROM NEW.style_no
       OR (event_record.after_state->>'documentQuantity')::bigint IS DISTINCT FROM (NEW.document_quantity_adjustment+(SELECT COALESCE(sum(document_quantity),0) FROM receiving_receipts WHERE receiving_batch_id=NEW.receiving_batch_id))
       OR (event_record.after_state->>'actualQuantity')::bigint IS DISTINCT FROM (NEW.actual_quantity_adjustment+(SELECT COALESCE(sum(actual_quantity),0) FROM receiving_receipts WHERE receiving_batch_id=NEW.receiving_batch_id))
    THEN RAISE EXCEPTION 'receiving correction does not match root audit event' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  IF action_name='delete' THEN
    IF event_record.action<>'receiving.batch.delete' OR NEW.style_no IS DISTINCT FROM OLD.style_no
       OR NEW.document_quantity_adjustment<>OLD.document_quantity_adjustment OR NEW.actual_quantity_adjustment<>OLD.actual_quantity_adjustment
       OR NEW.deleted_at IS NULL OR NEW.deleted_by IS DISTINCT FROM NEW.updated_by
       OR event_record.after_state->>'deleted' IS DISTINCT FROM 'true'
    THEN RAISE EXCEPTION 'receiving deletion does not match root audit event' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'receiving batch history is immutable' USING ERRCODE='55000';
END;
$$;


CREATE TABLE digital_whole_order_delete_requests (
 actor_id uuid NOT NULL REFERENCES app_users(id),
 idempotency_key text NOT NULL,
 input_hash text NOT NULL CHECK(length(input_hash)=64),
 PRIMARY KEY(actor_id,idempotency_key)
);
CREATE TRIGGER whole_order_delete_request_immutable BEFORE UPDATE OR DELETE ON digital_whole_order_delete_requests
 FOR EACH ROW EXECUTE FUNCTION guard_production_order_root_immutable();
