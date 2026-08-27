-- Sourcing PR03: IE reviewers must be able to enter the workbench they quote in.
DROP TRIGGER role_capabilities_no_insert ON role_capabilities;

INSERT INTO role_capabilities(role_code,capability) VALUES
  ('ie_reviewer','sourcing:view')
ON CONFLICT DO NOTHING;

CREATE TRIGGER role_capabilities_no_insert
  BEFORE INSERT ON role_capabilities FOR EACH ROW
  EXECUTE FUNCTION reject_operation_event_mutation();
