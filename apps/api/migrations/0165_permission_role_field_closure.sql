-- PR-03 permission closure: apply the approved role lifecycle and personnel-admin boundary.
-- Historical assignments remain intact for audit; disabled roles no longer contribute effective
-- authorization because authorization loading joins only enabled business_roles.

-- The standalone tail-inspector role is retired, but the business operation remains available to
-- ordinary workers through tail_inspection:report. Preserve existing operators by adding worker
-- assignments before the old role is disabled. Do not revoke the old rows: they remain immutable
-- historical evidence and become ineffective once the role is disabled.
ALTER TABLE user_role_assignments DISABLE TRIGGER user_role_assignments_guard_creation;

INSERT INTO user_role_assignments(
  assignment_id,user_id,role_code,granted_by,grant_reason,granted_at
)
SELECT
  gen_random_uuid(),legacy.user_id,'worker',legacy.granted_by,
  '独立整查角色退役：自动迁移为普通工人',legacy.granted_at
FROM user_role_assignments legacy
WHERE legacy.role_code='tail_inspector'
  AND legacy.revoked_at IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM user_role_assignments worker_assignment
    WHERE worker_assignment.user_id=legacy.user_id
      AND worker_assignment.role_code='worker'
      AND worker_assignment.revoked_at IS NULL
  );

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
-- need a persisted role capability, so no business role may retain access:admin.
ALTER TABLE role_capabilities DISABLE TRIGGER role_capabilities_no_delete;

DELETE FROM role_capabilities
WHERE capability='access:admin';

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
