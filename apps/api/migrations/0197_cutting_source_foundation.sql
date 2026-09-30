-- Cutting source foundation: owner approval creates one stable task per sourcing line.
-- This migration is additive only. It does not invent or backfill historical cutting facts.

ALTER TABLE capability_catalog DISABLE TRIGGER capability_catalog_no_insert;
ALTER TABLE business_roles DISABLE TRIGGER business_roles_no_insert;
ALTER TABLE role_capabilities DISABLE TRIGGER role_capabilities_no_insert;

INSERT INTO capability_catalog(capability,display_name,description) VALUES
 ('cutting:orders:view','查看裁床实裁','查看裁床源单安全字段；具体数据范围由裁床领域控制'),
 ('cutting:records:create','登记裁床实裁','登记裁片数与实裁数；本迁移仅声明能力，写入链路后续接入')
ON CONFLICT DO NOTHING;

INSERT INTO business_roles(role_code,display_name,description) VALUES
 ('cutting_supervisor','裁床主管','查看裁床业务记录并登记裁片数、实裁数'),
 ('cutting_worker','裁床工人','查看裁床业务记录并登记裁片数、实裁数')
ON CONFLICT DO NOTHING;

INSERT INTO role_capabilities(role_code,capability) VALUES
 ('cutting_supervisor','cutting:orders:view'),
 ('cutting_supervisor','cutting:records:create'),
 ('cutting_supervisor','tools:user'),
 ('cutting_worker','cutting:orders:view'),
 ('cutting_worker','cutting:records:create'),
 ('cutting_worker','tools:user'),
 ('owner_group','cutting:orders:view'),
 ('production_management','cutting:orders:view'),
 ('order_merchandiser','cutting:orders:view')
ON CONFLICT DO NOTHING;

ALTER TABLE role_capabilities ENABLE TRIGGER role_capabilities_no_insert;
ALTER TABLE business_roles ENABLE TRIGGER business_roles_no_insert;
ALTER TABLE capability_catalog ENABLE TRIGGER capability_catalog_no_insert;

CREATE OR REPLACE FUNCTION cutting_authorized_roles(actor_id uuid, requested_capability text)
RETURNS text[] LANGUAGE plpgsql STABLE AS $$
DECLARE actual_roles text[]; allowed_roles text[];
BEGIN
  actual_roles:=access_authorized_actor_roles(actor_id,requested_capability);
  IF 'root_superuser'=ANY(actual_roles) THEN RETURN actual_roles; END IF;
  CASE requested_capability
    WHEN 'cutting:orders:view' THEN
      allowed_roles:=ARRAY['cutting_supervisor','cutting_worker','owner_group','production_management','order_merchandiser']::text[];
    WHEN 'cutting:records:create' THEN
      allowed_roles:=ARRAY['cutting_supervisor','cutting_worker']::text[];
    ELSE
      RAISE EXCEPTION 'unknown cutting capability' USING ERRCODE='42501';
  END CASE;
  IF NOT actual_roles && allowed_roles THEN
    RAISE EXCEPTION 'cutting access denied' USING ERRCODE='42501';
  END IF;
  RETURN actual_roles;
END;
$$;

CREATE TABLE cutting_orders (
  cutting_order_id uuid PRIMARY KEY,
  sourcing_case_id uuid NOT NULL REFERENCES sourcing_cases(sourcing_case_id),
  sourcing_line_position integer NOT NULL CHECK(sourcing_line_position BETWEEN 1 AND 20),
  approval_snapshot_id uuid NOT NULL REFERENCES sourcing_approval_snapshots(sourcing_approval_snapshot_id),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(sourcing_case_id,sourcing_line_position),
  FOREIGN KEY(sourcing_case_id,sourcing_line_position)
    REFERENCES sourcing_case_lines(sourcing_case_id,position),
  FOREIGN KEY(approval_snapshot_id,sourcing_line_position)
    REFERENCES sourcing_approval_snapshot_lines(sourcing_approval_snapshot_id,position)
);

CREATE INDEX cutting_orders_source_idx
  ON cutting_orders(sourcing_case_id,sourcing_line_position);
CREATE INDEX cutting_orders_approval_idx
  ON cutting_orders(approval_snapshot_id,sourcing_line_position);

CREATE OR REPLACE FUNCTION guard_cutting_order_source()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM sourcing_approval_snapshots snapshot
    JOIN sourcing_approval_snapshot_lines line
      ON line.sourcing_approval_snapshot_id=snapshot.sourcing_approval_snapshot_id
     AND line.position=NEW.sourcing_line_position
    WHERE snapshot.sourcing_approval_snapshot_id=NEW.approval_snapshot_id
      AND snapshot.sourcing_case_id=NEW.sourcing_case_id
  ) THEN
    RAISE EXCEPTION 'cutting order requires matching approved sourcing line'
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER cutting_orders_guard_source
  BEFORE INSERT ON cutting_orders
  FOR EACH ROW EXECUTE FUNCTION guard_cutting_order_source();
CREATE TRIGGER cutting_orders_no_update
  BEFORE UPDATE ON cutting_orders
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER cutting_orders_no_delete
  BEFORE DELETE ON cutting_orders
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER cutting_orders_no_truncate
  BEFORE TRUNCATE ON cutting_orders
  FOR EACH STATEMENT EXECUTE FUNCTION reject_operation_event_mutation();
