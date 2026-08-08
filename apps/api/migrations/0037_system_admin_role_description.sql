-- Keep the visible administrator role description aligned with the reviewed
-- technical-administrator policy established by 0036.
DROP TRIGGER business_roles_no_update ON business_roles;

UPDATE business_roles
SET description='技术管理员：系统后台、技术异常处置和审计；不继承业务操作权限',
    updated_at=CURRENT_TIMESTAMP
WHERE role_code='system_admin';

CREATE TRIGGER business_roles_no_update
  BEFORE UPDATE ON business_roles FOR EACH ROW
  EXECUTE FUNCTION reject_operation_event_mutation();
