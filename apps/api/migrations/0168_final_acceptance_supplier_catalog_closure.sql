-- Final Acceptance Lab P1 follow-up: supplier_catalog is a selector-only legacy grant.
-- Quality control and tail supervisor use business-scoped supplier option endpoints instead of the
-- generic supplier center/catalog endpoint, so the generic capability is removed from both roles.

ALTER TABLE role_capabilities DISABLE TRIGGER role_capabilities_no_delete;

DELETE FROM role_capabilities
WHERE role_code IN ('quality_control','tail_supervisor')
  AND capability='supplier_catalog:read';

ALTER TABLE role_capabilities ENABLE TRIGGER role_capabilities_no_delete;
