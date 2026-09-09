-- PR-03 permission closure: apply the approved role lifecycle and personnel-admin boundary.
-- Historical assignments remain intact for audit; disabled roles no longer contribute effective
-- authorization because authorization loading joins only enabled business_roles.

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
