-- Deepen the receiving board with audited packing quantities, two independent
-- discrepancy-resolution ledgers, and an export capability matching board readers.

DROP TRIGGER IF EXISTS capability_catalog_no_insert ON capability_catalog;
DROP TRIGGER IF EXISTS role_capabilities_no_insert ON role_capabilities;

INSERT INTO capability_catalog(capability,display_name,description) VALUES
  ('receiving:export','导出订单回货','按当前订单回货筛选条件导出订单汇总与逐次收货明细'),
  ('receiving:resolve_difference','处理收货差异','仓管记录收货差异的处理结果'),
  ('receiving:packing_manage','管理装箱与装箱差异','尾部主管录入累计装箱数量并处理装箱差异')
ON CONFLICT (capability) DO NOTHING;

INSERT INTO role_capabilities(role_code,capability)
SELECT DISTINCT role_code,'receiving:export'
FROM role_capabilities
WHERE capability='tools:user'
ON CONFLICT DO NOTHING;

INSERT INTO role_capabilities(role_code,capability) VALUES
  ('warehouse_receiver','receiving:resolve_difference'),
  ('tail_supervisor','receiving:packing_manage')
ON CONFLICT DO NOTHING;

CREATE TRIGGER capability_catalog_no_insert
  BEFORE INSERT ON capability_catalog FOR EACH ROW
  EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER role_capabilities_no_insert
  BEFORE INSERT ON role_capabilities FOR EACH ROW
  EXECUTE FUNCTION reject_operation_event_mutation();

CREATE TABLE receiving_packing_revisions (
  packing_revision_id uuid PRIMARY KEY,
  receiving_batch_id uuid NOT NULL REFERENCES receiving_batches(receiving_batch_id),
  packing_quantity bigint NOT NULL CHECK(packing_quantity>=0 AND packing_quantity<=10000000),
  recorded_by uuid NOT NULL REFERENCES app_users(id),
  operation_event_id uuid NOT NULL UNIQUE REFERENCES operation_events(event_id),
  request_id text NOT NULL CHECK(request_id ~ '^[A-Za-z0-9._:-]{1,200}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX receiving_packing_revisions_latest_idx
  ON receiving_packing_revisions(receiving_batch_id,created_at DESC,packing_revision_id DESC);

CREATE TABLE receiving_difference_resolutions (
  resolution_id uuid PRIMARY KEY,
  receiving_batch_id uuid NOT NULL REFERENCES receiving_batches(receiving_batch_id),
  difference_type text NOT NULL CHECK(difference_type IN ('receiving','packing')),
  document_quantity_snapshot bigint NOT NULL CHECK(document_quantity_snapshot>0),
  actual_quantity_snapshot bigint NOT NULL CHECK(actual_quantity_snapshot>=0),
  packing_revision_id uuid REFERENCES receiving_packing_revisions(packing_revision_id),
  packing_quantity_snapshot bigint CHECK(packing_quantity_snapshot>=0),
  difference_quantity_snapshot bigint NOT NULL,
  result text NOT NULL CHECK(length(btrim(result)) BETWEEN 1 AND 500),
  handled_by uuid NOT NULL REFERENCES app_users(id),
  operation_event_id uuid NOT NULL UNIQUE REFERENCES operation_events(event_id),
  request_id text NOT NULL CHECK(request_id ~ '^[A-Za-z0-9._:-]{1,200}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK(
    (difference_type='receiving' AND packing_revision_id IS NULL AND packing_quantity_snapshot IS NULL
      AND difference_quantity_snapshot=actual_quantity_snapshot-document_quantity_snapshot)
    OR
    (difference_type='packing' AND packing_revision_id IS NOT NULL AND packing_quantity_snapshot IS NOT NULL
      AND difference_quantity_snapshot=actual_quantity_snapshot-packing_quantity_snapshot)
  )
);

CREATE INDEX receiving_difference_resolutions_latest_idx
  ON receiving_difference_resolutions(receiving_batch_id,difference_type,created_at DESC,resolution_id DESC);

CREATE FUNCTION guard_receiving_packing_revision_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE event_record operation_events%ROWTYPE;
BEGIN
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

CREATE FUNCTION guard_receiving_difference_resolution_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE event_record operation_events%ROWTYPE; expected_capability text;
BEGIN
  expected_capability:=CASE NEW.difference_type
    WHEN 'receiving' THEN 'receiving:resolve_difference'
    ELSE 'receiving:packing_manage'
  END;
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

CREATE FUNCTION guard_receiving_board_operation_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'receiving board operation history is immutable' USING ERRCODE='55000';
END;
$$;

CREATE TRIGGER receiving_packing_revisions_guard_insert
  BEFORE INSERT ON receiving_packing_revisions
  FOR EACH ROW EXECUTE FUNCTION guard_receiving_packing_revision_insert();
CREATE TRIGGER receiving_packing_revisions_no_update
  BEFORE UPDATE ON receiving_packing_revisions
  FOR EACH ROW EXECUTE FUNCTION guard_receiving_board_operation_immutable();
CREATE TRIGGER receiving_packing_revisions_no_delete
  BEFORE DELETE ON receiving_packing_revisions
  FOR EACH ROW EXECUTE FUNCTION guard_receiving_board_operation_immutable();
CREATE TRIGGER receiving_packing_revisions_no_truncate
  BEFORE TRUNCATE ON receiving_packing_revisions
  FOR EACH STATEMENT EXECUTE FUNCTION guard_receiving_board_operation_immutable();

CREATE TRIGGER receiving_difference_resolutions_guard_insert
  BEFORE INSERT ON receiving_difference_resolutions
  FOR EACH ROW EXECUTE FUNCTION guard_receiving_difference_resolution_insert();
CREATE TRIGGER receiving_difference_resolutions_no_update
  BEFORE UPDATE ON receiving_difference_resolutions
  FOR EACH ROW EXECUTE FUNCTION guard_receiving_board_operation_immutable();
CREATE TRIGGER receiving_difference_resolutions_no_delete
  BEFORE DELETE ON receiving_difference_resolutions
  FOR EACH ROW EXECUTE FUNCTION guard_receiving_board_operation_immutable();
CREATE TRIGGER receiving_difference_resolutions_no_truncate
  BEFORE TRUNCATE ON receiving_difference_resolutions
  FOR EACH STATEMENT EXECUTE FUNCTION guard_receiving_board_operation_immutable();
