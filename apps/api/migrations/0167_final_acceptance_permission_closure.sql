-- Final Acceptance Lab closure: remove three legacy over-grants exposed by the approved matrix.
-- Keep supplier_catalog:read intact for business selectors; only full supplier-center/profile access
-- is removed from quality control and tail supervisor.

ALTER TABLE role_capabilities DISABLE TRIGGER role_capabilities_no_delete;

DELETE FROM role_capabilities
WHERE role_code='owner_group'
  AND capability='audit:read';

DELETE FROM role_capabilities
WHERE role_code IN ('quality_control','tail_supervisor')
  AND capability='supplier_profile:read';

ALTER TABLE role_capabilities ENABLE TRIGGER role_capabilities_no_delete;
