-- PR-03 permission closure: apply the approved role lifecycle and personnel-admin boundary.
-- Historical assignments remain intact for audit; disabled roles no longer contribute effective
-- authorization because authorization loading joins only enabled business_roles.

-- The standalone tail-inspector role is retired, but the business operation remains available to
-- ordinary workers through tail_inspection:report. Preserve existing operators by adding worker
-- assignments before the old role is disabled. Each replacement grant is a NEW authorization at
-- migration time, not a historical rewrite. The immutable Root identity is the accountable migration
-- actor; the legacy grantor is retained only as source provenance.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM user_role_assignments legacy
    WHERE legacy.role_code='tail_inspector'
      AND legacy.revoked_at IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM user_role_assignments worker_assignment
        WHERE worker_assignment.user_id=legacy.user_id
          AND worker_assignment.role_code='worker'
          AND worker_assignment.revoked_at IS NULL
      )
  ) AND NOT EXISTS (
    SELECT 1
    FROM owner_bootstrap_consumptions root
    WHERE root.singleton=true
      AND access_is_root_actor(root.user_id)
  ) THEN
    RAISE EXCEPTION '0166 tail inspector migration requires an active Root actor'
      USING ERRCODE='42501';
  END IF;
END;
$$;

ALTER TABLE user_role_assignments DISABLE TRIGGER user_role_assignments_guard_creation;

WITH migration_actor AS (
  SELECT root.user_id actor_id
  FROM owner_bootstrap_consumptions root
  WHERE root.singleton=true
    AND access_is_root_actor(root.user_id)
  LIMIT 1
), replacements AS (
  SELECT
    gen_random_uuid() assignment_id,
    gen_random_uuid() event_id,
    legacy.assignment_id source_assignment_id,
    legacy.user_id,
    legacy.granted_by source_granted_by,
    migration_actor.actor_id migration_actor_id
  FROM user_role_assignments legacy
  CROSS JOIN migration_actor
  WHERE legacy.role_code='tail_inspector'
    AND legacy.revoked_at IS NULL
    AND NOT EXISTS (
      SELECT 1
      FROM user_role_assignments worker_assignment
      WHERE worker_assignment.user_id=legacy.user_id
        AND worker_assignment.role_code='worker'
        AND worker_assignment.revoked_at IS NULL
    )
), audit_rows AS (
  INSERT INTO operation_events(
    event_id,request_id,actor_id,actor_roles,authorization_capability,
    action,entity_type,entity_id,before_state,after_state,reason
  )
  SELECT
    replacement.event_id,
    'migration:0166:tail-inspector-to-worker:' || replacement.source_assignment_id::text,
    replacement.migration_actor_id,
    ARRAY['root_superuser','migration_0166'],
    'migration:role-retirement',
    'migration.role.tail_inspector_to_worker',
    'user_role_assignment',
    replacement.assignment_id::text,
    jsonb_build_object(
      'sourceAssignmentId',replacement.source_assignment_id,
      'sourceGrantedBy',replacement.source_granted_by,
      'roleCode','tail_inspector'
    ),
    jsonb_build_object(
      'userId',replacement.user_id,
      'roleCode','worker',
      'sourceAssignmentId',replacement.source_assignment_id,
      'sourceGrantedBy',replacement.source_granted_by,
      'migrationActorId',replacement.migration_actor_id,
      'migration','0166_permission_role_field_closure'
    ),
    '独立整查角色退役：迁移为普通工人；保留原角色授权历史'
  FROM replacements replacement
  RETURNING entity_id
)
INSERT INTO user_role_assignments(
  assignment_id,user_id,role_code,granted_by,grant_reason,granted_at
)
SELECT
  replacement.assignment_id,replacement.user_id,'worker',replacement.migration_actor_id,
  '独立整查角色退役：0166 迁移为普通工人；来源授权 '
    || replacement.source_assignment_id::text
    || '；原授权人 '
    || replacement.source_granted_by::text,
  CURRENT_TIMESTAMP
FROM replacements replacement
JOIN audit_rows audit ON audit.entity_id=replacement.assignment_id::text;

ALTER TABLE user_role_assignments ENABLE TRIGGER user_role_assignments_guard_creation;

-- Compatibility for stale internal callers and fixtures: a new tail_inspector assignment is never
-- persisted. It is normalized to worker before the normal audited assignment guard runs.
CREATE OR REPLACE FUNCTION normalize_retired_tail_role_assignment()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.role_code='tail_inspector' THEN
    NEW.role_code := 'worker';
    NEW.grant_reason := left(NEW.grant_reason,430) || '（独立整查角色已退役，按普通工人授权）';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS user_role_assignments_00_normalize_retired_tail_role ON user_role_assignments;
CREATE TRIGGER user_role_assignments_00_normalize_retired_tail_role
  BEFORE INSERT ON user_role_assignments
  FOR EACH ROW
  EXECUTE FUNCTION normalize_retired_tail_role_assignment();

DROP TRIGGER business_roles_no_update ON business_roles;

UPDATE business_roles
SET enabled=false,
    description=CASE
      WHEN position('（已退役）' in description)>0 THEN description
      ELSE description || '（已退役）'
    END
WHERE role_code IN ('administrative_clerk','sample_approver','tail_inspector')
  AND enabled=true;

CREATE TRIGGER business_roles_no_update
  BEFORE UPDATE ON business_roles FOR EACH ROW
  EXECUTE FUNCTION reject_operation_event_mutation();

-- Personnel/role administration is Root-only. Root uses the trusted identity bypass and does not
-- need a persisted role capability, so no business role may retain access:admin. System-admin is a
-- technical operator only: retain only explicitly technical capabilities and strip every business
-- grant that later migrations may have reintroduced (for example supplier-profile maintenance).
ALTER TABLE role_capabilities DISABLE TRIGGER role_capabilities_no_delete;

DELETE FROM role_capabilities
WHERE capability='access:admin';

DELETE FROM role_capabilities
WHERE role_code='system_admin'
  AND capability NOT IN (
    'tools:user',
    'admin:read',
    'admin:exception:manage',
    'audit:read',
    'todo:runtime',
    'erp:emergency_intake',
    'erp:result:read'
  );

ALTER TABLE role_capabilities ENABLE TRIGGER role_capabilities_no_delete;

-- Close the database authorization boundary as well as the HTTP boundary. Existing assignment and
-- revocation triggers call this function, so redefining it here makes every future role mutation
-- Root-only without rewriting historical migrations.
CREATE OR REPLACE FUNCTION access_role_manager_roles(
  requested_actor_id uuid
) RETURNS text[] LANGUAGE plpgsql STABLE AS $$
DECLARE
  actor_roles text[];
BEGIN
  IF NOT access_is_root_actor(requested_actor_id) THEN
    RAISE EXCEPTION 'business roles can only be maintained by root'
      USING ERRCODE='42501';
  END IF;

  SELECT array_agg(DISTINCT ura.role_code ORDER BY ura.role_code)
  INTO actor_roles
  FROM user_role_assignments ura
  JOIN business_roles br ON br.role_code=ura.role_code AND br.enabled=true
  JOIN app_users u ON u.id=ura.user_id AND u.enabled=true
  WHERE ura.user_id=requested_actor_id
    AND ura.revoked_at IS NULL
    AND EXISTS (
      SELECT 1
      FROM identity_mappings i
      JOIN access_security_policy policy
        ON policy.policy_key='primary'
       AND policy.dingtalk_corp_id=i.corp_id
      WHERE i.user_id=ura.user_id
        AND i.provider='dingtalk'
        AND i.active=true
        AND i.employed=true
    );

  RETURN array_append(COALESCE(actor_roles,'{}'::text[]),'root_superuser');
END;
$$;

-- Manual employee access state is also a Root-only personnel-admin action. Normal authentication and
-- authorization lifecycle writes remain valid when they merely converge enabled to the effective
-- authorization state; the explicit manual-disable/restore transitions require the Root actor context
-- established by EmployeeAccessService inside the same transaction.
CREATE OR REPLACE FUNCTION guard_employee_access_state_root()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  requested_actor_id uuid;
  effective_authorization boolean;
BEGIN
  IF NEW.enabled IS NOT DISTINCT FROM OLD.enabled
     AND NEW.manual_access_disabled IS NOT DISTINCT FROM OLD.manual_access_disabled THEN
    RETURN NEW;
  END IF;

  effective_authorization := access_is_root_actor(NEW.id)
    OR access_user_has_effective_authorization(NEW.id);

  IF (
    OLD.manual_access_disabled=false
    AND NEW.manual_access_disabled=true
  ) OR (
    OLD.manual_access_disabled=true
    AND NEW.manual_access_disabled=false
    AND OLD.enabled=false
    AND NEW.enabled=true
  ) OR (
    OLD.enabled=true
    AND NEW.enabled=false
    AND NEW.manual_access_disabled=false
    AND effective_authorization=true
  ) THEN
    requested_actor_id := nullif(
      current_setting('dx_rework.employee_access_actor_id',true),
      ''
    )::uuid;
    IF requested_actor_id IS NULL OR NOT access_is_root_actor(requested_actor_id) THEN
      RAISE EXCEPTION 'employee access state can only be maintained by root'
        USING ERRCODE='42501';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS app_users_employee_access_root_guard ON app_users;
CREATE TRIGGER app_users_employee_access_root_guard
  BEFORE UPDATE OF enabled,manual_access_disabled ON app_users
  FOR EACH ROW
  EXECUTE FUNCTION guard_employee_access_state_root();

-- Prevent future delegated capability from recreating a business-user personnel-admin path.
CREATE OR REPLACE FUNCTION reject_access_admin_delegation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.capability='access:admin' THEN
    RAISE EXCEPTION 'access:admin is Root-only and cannot be delegated'
      USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS delegated_authorizations_no_access_admin ON delegated_authorizations;
CREATE TRIGGER delegated_authorizations_no_access_admin
  BEFORE INSERT ON delegated_authorizations
  FOR EACH ROW
  EXECUTE FUNCTION reject_access_admin_delegation();

-- The legacy tail-inspection assignment table is retained because it is immutable historical
-- workflow evidence. New assignments now target an ordinary worker that carries the existing
-- tail_inspection:report capability.
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
     AND role_assignment.role_code='worker'
     AND role_assignment.revoked_at IS NULL
    JOIN business_roles role
      ON role.role_code=role_assignment.role_code AND role.enabled=true
    JOIN role_capabilities capability
      ON capability.role_code=role_assignment.role_code
     AND capability.capability='tail_inspection:report'
    WHERE inspector.id=NEW.tail_inspector_user_id AND inspector.enabled=true
  ) THEN
    RAISE EXCEPTION 'tail inspection assignment requires an active worker with tail inspection reporting permission'
      USING ERRCODE='42501';
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

-- Unified tail-inspection work reports are new business mutations, so immutable historical actor
-- snapshots that still contain tail_inspector must not authorize them. Require the actual event actor
-- to be Root or a currently active ordinary worker carrying tail_inspection:report.
CREATE OR REPLACE FUNCTION guard_rework_work_report_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  task_execution_kind text;
BEGIN
  SELECT item.execution_kind
  INTO task_execution_kind
  FROM rework_work_tasks task
  JOIN rework_process_configuration_items item
    ON item.configuration_item_id=task.configuration_item_id
  WHERE task.work_task_id=NEW.work_task_id
    AND task.rework_order_id=NEW.rework_order_id
    AND task.configuration_item_id=NEW.configuration_item_id;

  IF task_execution_kind IS NULL OR NOT EXISTS (
    SELECT 1
    FROM operation_events event
    WHERE event.event_id=nullif(current_setting('dx_rework.work_event_id',true),'')::uuid
      AND event.request_id=nullif(current_setting('dx_rework.work_request_id',true),'')
      AND event.action='rework.work_report.submit'
      AND event.authorization_capability=(
        CASE task_execution_kind
          WHEN 'tail_inspection' THEN 'tail_inspection:report'
          ELSE event.authorization_capability
        END
      )
      AND (
        task_execution_kind='tail_inspection'
        OR event.authorization_capability IN ('work:report','work:report_for_worker')
      )
      AND (
        task_execution_kind<>'tail_inspection'
        OR access_is_root_actor(event.actor_id)
        OR EXISTS (
          SELECT 1
          FROM app_users reporter
          JOIN user_role_assignments assignment
            ON assignment.user_id=reporter.id
           AND assignment.role_code='worker'
           AND assignment.revoked_at IS NULL
          JOIN business_roles role
            ON role.role_code=assignment.role_code
           AND role.enabled=true
          JOIN role_capabilities capability
            ON capability.role_code=assignment.role_code
           AND capability.capability='tail_inspection:report'
          JOIN identity_mappings identity
            ON identity.user_id=reporter.id
           AND identity.provider='dingtalk'
           AND identity.active=true
           AND identity.employed=true
          JOIN access_security_policy policy
            ON policy.policy_key='primary'
           AND policy.dingtalk_corp_id=identity.corp_id
          WHERE reporter.id=event.actor_id
            AND reporter.enabled=true
        )
      )
      AND event.entity_type='rework_order'
      AND event.entity_id=NEW.rework_order_id::text
  ) THEN
    RAISE EXCEPTION 'work report requires current execution-kind authorization'
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;

-- Historical todo/source-event snapshots may still name tail_inspector. Keep those immutable facts
-- usable by interpreting that retired role only for tail_inspection:report as the current worker
-- role. This does not re-enable or assign tail_inspector.
CREATE OR REPLACE FUNCTION todo_user_has_direct_role(
  candidate uuid,
  required_role text,
  required_capability text
) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT access_is_root_actor(candidate)
  OR EXISTS (
    SELECT 1
    FROM user_role_assignments assignment
    JOIN business_roles role
      ON role.role_code=assignment.role_code AND role.enabled=true
    JOIN role_capabilities capability
      ON capability.role_code=assignment.role_code
     AND capability.capability=required_capability
    JOIN app_users user_record
      ON user_record.id=assignment.user_id AND user_record.enabled=true
    JOIN identity_mappings identity
      ON identity.user_id=user_record.id AND identity.provider='dingtalk'
     AND identity.active=true AND identity.employed=true
    JOIN access_security_policy policy
      ON policy.policy_key='primary'
     AND policy.dingtalk_corp_id=identity.corp_id
    WHERE assignment.user_id=candidate
      AND assignment.role_code=CASE
        WHEN required_role='tail_inspector' AND required_capability='tail_inspection:report'
          THEN 'worker'
        ELSE required_role
      END
      AND assignment.revoked_at IS NULL
  );
$$;
