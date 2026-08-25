-- PR-01 receiving fact layer: warehouse creates immutable receiving facts.
-- Receiving records are independent from rework orders; a rework order is created only later by QC.

DROP TRIGGER IF EXISTS capability_catalog_no_insert ON capability_catalog;
DROP TRIGGER IF EXISTS role_capabilities_no_insert ON role_capabilities;
DROP TRIGGER IF EXISTS role_capabilities_no_delete ON role_capabilities;
DROP TRIGGER IF EXISTS business_roles_no_insert ON business_roles;

INSERT INTO capability_catalog(capability,display_name,description) VALUES
  ('receiving:create','仓库收货','创建真实收货记录并自动记录差异、时间和收货人')
ON CONFLICT DO NOTHING;

INSERT INTO business_roles(role_code,display_name,description) VALUES
  ('warehouse_receiver','仓管人员','使用极简移动端入口登记收货事实')
ON CONFLICT DO NOTHING;

INSERT INTO role_capabilities(role_code,capability) VALUES
  ('warehouse_receiver','tools:user'),
  ('warehouse_receiver','receiving:create')
ON CONFLICT DO NOTHING;

CREATE TRIGGER capability_catalog_no_insert
  BEFORE INSERT ON capability_catalog FOR EACH ROW
  EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER role_capabilities_no_insert
  BEFORE INSERT ON role_capabilities FOR EACH ROW
  EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER role_capabilities_no_delete
  BEFORE DELETE ON role_capabilities FOR EACH ROW
  EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER business_roles_no_insert
  BEFORE INSERT ON business_roles FOR EACH ROW
  EXECUTE FUNCTION reject_operation_event_mutation();

CREATE TABLE receiving_receipts (
  receipt_id uuid PRIMARY KEY,
  style_no text NOT NULL CHECK(length(btrim(style_no)) BETWEEN 1 AND 100),
  document_quantity integer NOT NULL CHECK(document_quantity>0),
  actual_quantity integer NOT NULL CHECK(actual_quantity>=0),
  difference_quantity integer GENERATED ALWAYS AS (actual_quantity-document_quantity) STORED,
  received_by uuid NOT NULL REFERENCES app_users(id),
  received_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  operation_event_id uuid NOT NULL REFERENCES operation_events(event_id),
  request_id text NOT NULL CHECK(request_id ~ '^[A-Za-z0-9._:-]{1,128}$')
);

CREATE INDEX receiving_receipts_style_time_idx
  ON receiving_receipts(style_no,received_at,receipt_id);
CREATE INDEX receiving_receipts_time_idx
  ON receiving_receipts(received_at,receipt_id);

CREATE OR REPLACE FUNCTION guard_receiving_receipt_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE event_record operation_events%ROWTYPE;
BEGIN
  SELECT * INTO event_record
  FROM operation_events
  WHERE event_id=nullif(current_setting('dx_rework.receiving_event_id',true),'')::uuid
    AND request_id=nullif(current_setting('dx_rework.receiving_request_id',true),'')
    AND actor_id=NEW.received_by
    AND action='receiving.receipt.create'
    AND authorization_capability='receiving:create'
    AND entity_type='receiving_receipt'
    AND entity_id=NEW.receipt_id::text;

  IF event_record.event_id IS NULL
     OR NEW.operation_event_id<>event_record.event_id
     OR NEW.request_id<>event_record.request_id
  THEN
    RAISE EXCEPTION 'receiving receipt requires matching warehouse audit event'
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER receiving_receipts_guard_insert
  BEFORE INSERT ON receiving_receipts
  FOR EACH ROW EXECUTE FUNCTION guard_receiving_receipt_insert();
CREATE TRIGGER receiving_receipts_no_update
  BEFORE UPDATE ON receiving_receipts
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER receiving_receipts_no_delete
  BEFORE DELETE ON receiving_receipts
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER receiving_receipts_no_truncate
  BEFORE TRUNCATE ON receiving_receipts
  FOR EACH STATEMENT EXECUTE FUNCTION reject_operation_event_mutation();
