-- N04 assignment corrections and temporary-worker quick creation.
-- Tail supervisors may create only temporary workers through the dedicated API;
-- existing master-data management remains unchanged.

DROP TRIGGER capability_catalog_no_insert ON capability_catalog;
DROP TRIGGER role_capabilities_no_insert ON role_capabilities;

INSERT INTO capability_catalog(capability,display_name,description) VALUES
  ('temporary_worker:manage','临时工管理','在返工分配现场新增临时工作业人员')
ON CONFLICT (capability) DO NOTHING;

INSERT INTO role_capabilities(role_code,capability) VALUES
  ('tail_supervisor','temporary_worker:manage'),
  ('owner_group','temporary_worker:manage')
ON CONFLICT DO NOTHING;

CREATE TRIGGER capability_catalog_no_insert
  BEFORE INSERT ON capability_catalog FOR EACH ROW
  EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER role_capabilities_no_insert
  BEFORE INSERT ON role_capabilities FOR EACH ROW
  EXECUTE FUNCTION reject_operation_event_mutation();

CREATE OR REPLACE FUNCTION guard_business_person_creation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  audit_event_id text := nullif(current_setting('dx_rework.person_create_event_id', true), '');
  audit_request_id text := nullif(current_setting('dx_rework.person_create_request_id', true), '');
  audit_capability text;
  audit_actor_roles text[];
BEGIN
  IF NEW.active IS DISTINCT FROM true
     OR NEW.deactivated_at IS NOT NULL OR NEW.deactivated_by IS NOT NULL OR NEW.deactivate_reason IS NOT NULL
  THEN
    RAISE EXCEPTION 'new business people must start active'
      USING ERRCODE = '23514';
  END IF;
  IF audit_event_id IS NULL OR audit_request_id IS NULL
     OR audit_request_id !~ '^[A-Za-z0-9._:-]{1,128}$'
  THEN
    RAISE EXCEPTION 'business person creation requires trusted audit context'
      USING ERRCODE = '55000';
  END IF;

  SELECT e.authorization_capability
  INTO audit_capability
  FROM operation_events e
  WHERE e.event_id=audit_event_id::uuid
    AND e.request_id=audit_request_id
    AND e.actor_id=NEW.created_by;

  IF audit_capability IS NULL
     OR (NEW.person_type='internal' AND audit_capability<>'master_data:manage')
     OR (
       NEW.person_type='temporary'
       AND audit_capability NOT IN ('master_data:manage','temporary_worker:manage')
     )
  THEN
    RAISE EXCEPTION 'business person creation capability does not match person type'
      USING ERRCODE = '42501';
  END IF;

  audit_actor_roles := access_authorized_actor_roles(NEW.created_by, audit_capability);

  IF NEW.person_type='internal' AND NOT EXISTS (
    SELECT 1
    FROM app_users u
    JOIN identity_mappings i ON i.user_id=u.id
    JOIN access_security_policy policy
      ON policy.policy_key='primary' AND policy.dingtalk_corp_id=i.corp_id
    WHERE u.id=NEW.app_user_id AND u.enabled=true
      AND i.provider='dingtalk' AND i.active=true AND i.employed=true
  ) THEN
    RAISE EXCEPTION 'internal business person must use an active employee in the configured corporation'
      USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM operation_events e
    WHERE e.event_id=audit_event_id::uuid
      AND e.request_id=audit_request_id
      AND e.actor_id=NEW.created_by
      AND e.actor_roles=audit_actor_roles
      AND e.authorization_capability=audit_capability
      AND e.action='master_data.person.create'
      AND e.entity_type='business_person'
      AND e.entity_id=NEW.person_id::text
      AND e.after_state->>'personType'=NEW.person_type
      AND (e.after_state->>'appUserId')::uuid IS NOT DISTINCT FROM NEW.app_user_id
      AND e.after_state->>'displayName'=NEW.display_name
      AND e.after_state->>'active'='true'
      AND length(btrim(e.reason)) BETWEEN 1 AND 500
  ) THEN
    RAISE EXCEPTION 'business person creation event does not match the row'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION guard_rework_work_task_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.work_task_id IS DISTINCT FROM OLD.work_task_id OR NEW.rework_order_id IS DISTINCT FROM OLD.rework_order_id
     OR NEW.configuration_item_id IS DISTINCT FROM OLD.configuration_item_id OR NEW.task_version IS DISTINCT FROM OLD.task_version
     OR NEW.assignment_mode IS DISTINCT FROM OLD.assignment_mode OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.source_system IS DISTINCT FROM OLD.source_system OR NEW.external_id IS DISTINCT FROM OLD.external_id
     OR NEW.external_idempotency_key IS DISTINCT FROM OLD.external_idempotency_key OR NEW.erp_node_id IS DISTINCT FROM OLD.erp_node_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at OR OLD.status<>'active' OR NEW.status<>'superseded'
     OR NEW.superseded_at IS NULL OR NOT EXISTS (
       SELECT 1 FROM operation_events e
       WHERE e.event_id=current_setting('dx_rework.work_event_id',true)::uuid
         AND e.request_id=current_setting('dx_rework.work_request_id',true)
         AND e.action IN ('rework.work_task.assign','rework.work_task.remove')
         AND e.authorization_capability='work:assign'
         AND e.entity_type='rework_order'
         AND e.entity_id=OLD.rework_order_id::text
     )
  THEN
    RAISE EXCEPTION 'work task versions may only be superseded through assignment or audited removal'
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;
