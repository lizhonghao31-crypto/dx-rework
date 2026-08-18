-- Tail inspection is an independent physical-count fact source. This migration
-- creates only the role and immutable data foundation; runtime flow activation
-- is intentionally delivered by the following focused workflow PR.

DROP TRIGGER capability_catalog_no_insert ON capability_catalog;
DROP TRIGGER role_capabilities_no_insert ON role_capabilities;
DROP TRIGGER role_capabilities_no_delete ON role_capabilities;
DROP TRIGGER business_roles_no_insert ON business_roles;

INSERT INTO capability_catalog(capability,display_name,description) VALUES
  ('tail_inspection:report','尾查报数','仅对已分配返工单提交或重提尾查数量')
ON CONFLICT DO NOTHING;

INSERT INTO business_roles(role_code,display_name,description) VALUES
  ('tail_inspector','尾查','清点返件并仅操作本人被分配的尾查报数')
ON CONFLICT DO NOTHING;

INSERT INTO role_capabilities(role_code,capability) VALUES
  ('tail_inspector','tools:user'),
  ('tail_inspector','tail_inspection:report')
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

CREATE TABLE rework_tail_inspection_assignments (
  tail_inspection_assignment_id uuid PRIMARY KEY,
  rework_order_id uuid NOT NULL REFERENCES rework_orders(rework_order_id),
  tail_inspector_user_id uuid NOT NULL REFERENCES app_users(id),
  assigned_by uuid NOT NULL REFERENCES app_users(id),
  box_scope text CHECK (box_scope IS NULL OR length(btrim(box_scope)) BETWEEN 1 AND 200),
  assigned_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at timestamptz,
  revoked_by uuid REFERENCES app_users(id),
  revoke_reason text,
  operation_event_id uuid NOT NULL REFERENCES operation_events(event_id),
  request_id text NOT NULL CHECK (request_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  CHECK (
    (revoked_at IS NULL AND revoked_by IS NULL AND revoke_reason IS NULL)
    OR
    (revoked_at IS NOT NULL AND revoked_by IS NOT NULL
      AND length(btrim(revoke_reason)) BETWEEN 1 AND 500)
  )
);
CREATE UNIQUE INDEX rework_tail_inspection_assignments_active_user_idx
  ON rework_tail_inspection_assignments(rework_order_id,tail_inspector_user_id)
  WHERE revoked_at IS NULL;
CREATE INDEX rework_tail_inspection_assignments_order_idx
  ON rework_tail_inspection_assignments(rework_order_id,assigned_at DESC);

CREATE TABLE rework_tail_inspection_reports (
  tail_inspection_report_id uuid PRIMARY KEY,
  tail_inspection_assignment_id uuid NOT NULL
    REFERENCES rework_tail_inspection_assignments(tail_inspection_assignment_id),
  rework_order_id uuid NOT NULL REFERENCES rework_orders(rework_order_id),
  returned_quantity numeric(12,0) NOT NULL
    CHECK(returned_quantity>0 AND returned_quantity=trunc(returned_quantity,0)),
  status text NOT NULL CHECK(status IN ('submitted','rejected','superseded')),
  submitted_by uuid NOT NULL REFERENCES app_users(id),
  submitted_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  rejected_at timestamptz,
  rejected_by uuid REFERENCES app_users(id),
  rejection_reason text,
  supersedes_report_id uuid REFERENCES rework_tail_inspection_reports(tail_inspection_report_id),
  operation_event_id uuid NOT NULL REFERENCES operation_events(event_id),
  request_id text NOT NULL CHECK(request_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  CHECK (
    (status='submitted' AND rejected_at IS NULL AND rejected_by IS NULL AND rejection_reason IS NULL)
    OR
    (status='rejected' AND rejected_at IS NOT NULL AND rejected_by IS NOT NULL
      AND length(btrim(rejection_reason)) BETWEEN 1 AND 500)
    OR
    (status='superseded' AND supersedes_report_id IS NOT NULL)
  )
);
CREATE UNIQUE INDEX rework_tail_inspection_reports_active_assignment_idx
  ON rework_tail_inspection_reports(tail_inspection_assignment_id)
  WHERE status='submitted';
CREATE INDEX rework_tail_inspection_reports_order_idx
  ON rework_tail_inspection_reports(rework_order_id,submitted_at DESC);

CREATE TABLE rework_tail_inspection_report_items (
  tail_inspection_report_id uuid NOT NULL
    REFERENCES rework_tail_inspection_reports(tail_inspection_report_id),
  configuration_item_id uuid NOT NULL
    REFERENCES rework_process_configuration_items(configuration_item_id),
  inspected_quantity numeric(12,0) NOT NULL
    CHECK(inspected_quantity>=0 AND inspected_quantity=trunc(inspected_quantity,0)),
  PRIMARY KEY(tail_inspection_report_id,configuration_item_id)
);
CREATE INDEX rework_tail_inspection_report_items_configuration_idx
  ON rework_tail_inspection_report_items(configuration_item_id);

CREATE OR REPLACE FUNCTION guard_rework_tail_inspection_assignment_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.revoked_at IS NOT NULL OR NEW.revoked_by IS NOT NULL OR NEW.revoke_reason IS NOT NULL THEN
    RAISE EXCEPTION 'tail inspection assignment must start active' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS(
    SELECT 1
    FROM app_users inspector
    JOIN user_role_assignments role_assignment
      ON role_assignment.user_id=inspector.id
     AND role_assignment.role_code='tail_inspector'
     AND role_assignment.revoked_at IS NULL
    JOIN business_roles role
      ON role.role_code=role_assignment.role_code AND role.enabled=true
    JOIN role_capabilities capability
      ON capability.role_code=role_assignment.role_code
     AND capability.capability='tail_inspection:report'
    WHERE inspector.id=NEW.tail_inspector_user_id AND inspector.enabled=true
  ) THEN
    RAISE EXCEPTION 'tail inspection assignment requires an active tail inspector' USING ERRCODE='42501';
  END IF;
  IF NOT EXISTS(
    SELECT 1
    FROM operation_events event
    WHERE event.event_id=NEW.operation_event_id
      AND event.request_id=NEW.request_id
      AND event.actor_id=NEW.assigned_by
      AND event.action='rework.process_configuration.submit'
      AND event.authorization_capability='process:configure'
      AND event.entity_type='rework_order'
      AND event.entity_id=NEW.rework_order_id::text
  ) THEN
    RAISE EXCEPTION 'tail inspection assignment requires the matching N02 submit event'
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER rework_tail_inspection_assignments_guard_insert
  BEFORE INSERT ON rework_tail_inspection_assignments
  FOR EACH ROW EXECUTE FUNCTION guard_rework_tail_inspection_assignment_insert();
CREATE TRIGGER rework_tail_inspection_assignments_no_delete
  BEFORE DELETE ON rework_tail_inspection_assignments
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER rework_tail_inspection_assignments_no_truncate
  BEFORE TRUNCATE ON rework_tail_inspection_assignments
  FOR EACH STATEMENT EXECUTE FUNCTION reject_operation_event_mutation();

CREATE OR REPLACE FUNCTION guard_rework_tail_inspection_assignment_revoke()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.revoked_at IS NOT NULL
     OR NEW.tail_inspection_assignment_id IS DISTINCT FROM OLD.tail_inspection_assignment_id
     OR NEW.rework_order_id IS DISTINCT FROM OLD.rework_order_id
     OR NEW.tail_inspector_user_id IS DISTINCT FROM OLD.tail_inspector_user_id
     OR NEW.assigned_by IS DISTINCT FROM OLD.assigned_by
     OR NEW.box_scope IS DISTINCT FROM OLD.box_scope
     OR NEW.assigned_at IS DISTINCT FROM OLD.assigned_at
     OR NEW.operation_event_id IS DISTINCT FROM OLD.operation_event_id
     OR NEW.request_id IS DISTINCT FROM OLD.request_id
     OR NEW.revoked_at IS NULL OR NEW.revoked_by IS NULL
     OR length(btrim(NEW.revoke_reason)) NOT BETWEEN 1 AND 500
  THEN
    RAISE EXCEPTION 'tail inspection assignment is immutable except for one reasoned revocation'
      USING ERRCODE='55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM operation_events event
    WHERE event.event_id=NULLIF(current_setting('dx_rework.rework_event_id', true),'')::uuid
      AND event.request_id=current_setting('dx_rework.request_id', true)
      AND event.actor_id=NEW.revoked_by
      AND event.action='rework.tail_inspection.revoke'
      AND event.authorization_capability='process:configure'
      AND event.entity_type='rework_tail_inspection_assignment'
      AND event.entity_id=NEW.tail_inspection_assignment_id::text
  ) THEN
    RAISE EXCEPTION 'tail inspection assignment revocation requires its matching audit event'
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER rework_tail_inspection_assignments_guard_revoke
  BEFORE UPDATE ON rework_tail_inspection_assignments
  FOR EACH ROW EXECUTE FUNCTION guard_rework_tail_inspection_assignment_revoke();

CREATE OR REPLACE FUNCTION guard_rework_tail_inspection_report_item()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE report_returned_quantity numeric(12,0);
BEGIN
  SELECT returned_quantity INTO report_returned_quantity
  FROM rework_tail_inspection_reports
  WHERE tail_inspection_report_id=NEW.tail_inspection_report_id;
  IF report_returned_quantity IS NULL OR NEW.inspected_quantity>report_returned_quantity THEN
    RAISE EXCEPTION 'tail inspection process quantity cannot exceed the reporter returned quantity'
      USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS(
    SELECT 1
    FROM rework_tail_inspection_reports report
    JOIN rework_process_configuration_items item
      ON item.configuration_item_id=NEW.configuration_item_id
    JOIN rework_process_configurations configuration
      ON configuration.configuration_id=item.configuration_id
    WHERE report.tail_inspection_report_id=NEW.tail_inspection_report_id
      AND configuration.rework_order_id=report.rework_order_id
  ) THEN
    RAISE EXCEPTION 'tail inspection process must belong to the same rework order'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER rework_tail_inspection_report_items_guard_insert
  BEFORE INSERT ON rework_tail_inspection_report_items
  FOR EACH ROW EXECUTE FUNCTION guard_rework_tail_inspection_report_item();
CREATE TRIGGER rework_tail_inspection_report_items_no_update
  BEFORE UPDATE ON rework_tail_inspection_report_items
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER rework_tail_inspection_report_items_no_delete
  BEFORE DELETE ON rework_tail_inspection_report_items
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER rework_tail_inspection_report_items_no_truncate
  BEFORE TRUNCATE ON rework_tail_inspection_report_items
  FOR EACH STATEMENT EXECUTE FUNCTION reject_operation_event_mutation();

CREATE OR REPLACE FUNCTION guard_rework_tail_inspection_report_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status<>'submitted'
     OR NEW.rejected_at IS NOT NULL OR NEW.rejected_by IS NOT NULL
     OR NEW.rejection_reason IS NOT NULL OR NEW.supersedes_report_id IS NOT NULL
  THEN
    RAISE EXCEPTION 'a new tail inspection report must start submitted' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS(
    SELECT 1
    FROM rework_tail_inspection_assignments assignment
    JOIN rework_orders target ON target.rework_order_id=assignment.rework_order_id
    JOIN operation_events event ON event.event_id=NEW.operation_event_id
    WHERE assignment.tail_inspection_assignment_id=NEW.tail_inspection_assignment_id
      AND assignment.revoked_at IS NULL
      AND assignment.rework_order_id=NEW.rework_order_id
      AND assignment.tail_inspector_user_id=NEW.submitted_by
      AND target.status NOT IN ('draft','cancelled','completed','deleted')
      AND event.request_id=NEW.request_id
      AND event.actor_id=NEW.submitted_by
      AND event.action='rework.tail_inspection.submit'
      AND event.authorization_capability='tail_inspection:report'
      AND event.entity_type='rework_tail_inspection_assignment'
      AND event.entity_id=NEW.tail_inspection_assignment_id::text
  ) THEN
    RAISE EXCEPTION 'tail inspection report requires the matching assigned-tail audit event'
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER rework_tail_inspection_reports_guard_insert
  BEFORE INSERT ON rework_tail_inspection_reports
  FOR EACH ROW EXECUTE FUNCTION guard_rework_tail_inspection_report_insert();
CREATE TRIGGER rework_tail_inspection_reports_no_update
  BEFORE UPDATE ON rework_tail_inspection_reports
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER rework_tail_inspection_reports_no_delete
  BEFORE DELETE ON rework_tail_inspection_reports
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER rework_tail_inspection_reports_no_truncate
  BEFORE TRUNCATE ON rework_tail_inspection_reports
  FOR EACH STATEMENT EXECUTE FUNCTION reject_operation_event_mutation();
