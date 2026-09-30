-- Owner group maintains business master data used by the rework workflow.
-- Protected role assignment remains Root-only at the application layer.
DROP TRIGGER role_capabilities_no_insert ON role_capabilities;

INSERT INTO role_capabilities(role_code, capability) VALUES
  ('owner_group', 'master_data:manage')
ON CONFLICT DO NOTHING;

CREATE TRIGGER role_capabilities_no_insert
  BEFORE INSERT ON role_capabilities FOR EACH ROW
  EXECUTE FUNCTION reject_operation_event_mutation();
