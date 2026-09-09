-- PR-03 permission closure: apply the approved role lifecycle and personnel-admin boundary.
-- Historical assignments remain intact for audit; disabled roles no longer contribute effective
-- authorization because authorization loading joins only enabled business_roles.

-- The standalone tail-inspector role is retired, but the business operation remains available to
-- ordinary workers through tail_inspection:report. Preserve existing operators by adding worker
-- assignments before the old role is disabled. Each replacement grant is a NEW authorization at
-- migration time, not a historical rewrite: keep the legacy row untouched and emit an explicit
-- append-only migration event tied to the newly created assignment.
ALTER TABLE user_role_assignments DISABLE TRIGGER user_role_assignments_guard_creation;

WITH replacements AS (
  SELECT
    gen_random_uuid() assignment_id,
    gen_random_uuid() event_id,
    legacy.assignment_id source_assignment_id,
    legacy.user_id,
    legacy.granted_by
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
), audit_rows AS (
  INSERT INTO operation_events(
    event_id,request_id,actor_id,actor_roles,authorization_capability,
    action,entity_type,entity_id,before_state,after_state,reason
  )
  SELECT
    replacement.event_id,
    'migration:0165:tail-inspector-to-worker:' || replacement.source_assignment_id::text,
    replacement.granted_by,
    ARRAY['migration_0165'],
    'migration:role-retirement',
    'migration.role.tail_inspector_to_worker',
    'user_role_assignment',
    replacement.assignment_id::text,
    jsonb_build_object(
      'sourceAssignmentId',replacement.source_assignment_id,
      'roleCode','tail_inspector'
    ),
    jsonb_build_object(
      'userId',replacement.user_id,
      'roleCode','worker',
      'sourceAssignmentId',replacement.source_assignment_id,
      'migration','0165_permission_role_field_closure'
    ),
    '独立整查角色退役：迁移为普通工人；保留原角色授权历史'
  FROM replacements replacement
  RETURNING entity_id
)
INSERT INTO user_role_assignments(
  assignment_id,user_id,role_code,granted_by,grant_reason,granted_at
)
SELECT
  replacement.assignment_id,replacement.user_id,'worker',replacement.granted_by,
  '独立整查角色退役：0165 迁移为普通工人；来源授权 ' || replacement.source_assignment_id::text,
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
