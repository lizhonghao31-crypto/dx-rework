-- PR-15 batch 1: administrator audit query foundation.
-- Adds/keeps the reviewed read-only audit capability assignment and query
-- indexes over the existing immutable operation_events ledger only.

DROP TRIGGER capability_catalog_no_insert ON capability_catalog;
DROP TRIGGER role_capabilities_no_insert ON role_capabilities;

INSERT INTO capability_catalog(capability,display_name,description) VALUES
  ('audit:read','审计查看','系统管理员只读查询操作审计事件和导出审计日志')
ON CONFLICT (capability) DO UPDATE SET
  display_name=EXCLUDED.display_name,
  description=EXCLUDED.description;

INSERT INTO role_capabilities(role_code,capability) VALUES
  ('system_admin','audit:read')
ON CONFLICT DO NOTHING;

CREATE TRIGGER capability_catalog_no_insert
  BEFORE INSERT ON capability_catalog FOR EACH ROW
  EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER role_capabilities_no_insert
  BEFORE INSERT ON role_capabilities FOR EACH ROW
  EXECUTE FUNCTION reject_operation_event_mutation();

CREATE INDEX IF NOT EXISTS operation_events_admin_audit_seek_idx
  ON operation_events(created_at DESC,event_id DESC);
CREATE INDEX IF NOT EXISTS operation_events_admin_audit_actor_seek_idx
  ON operation_events(actor_id,created_at DESC,event_id DESC);
CREATE INDEX IF NOT EXISTS operation_events_admin_audit_action_seek_idx
  ON operation_events(action,created_at DESC,event_id DESC);
CREATE INDEX IF NOT EXISTS operation_events_admin_audit_entity_seek_idx
  ON operation_events(entity_type,entity_id,created_at DESC,event_id DESC);
CREATE INDEX IF NOT EXISTS operation_events_admin_audit_capability_seek_idx
  ON operation_events(authorization_capability,created_at DESC,event_id DESC);
CREATE INDEX IF NOT EXISTS operation_events_admin_audit_request_seek_idx
  ON operation_events(request_id,created_at DESC,event_id DESC);
CREATE INDEX IF NOT EXISTS operation_events_admin_audit_exports_seek_idx
  ON operation_events(created_at DESC,event_id DESC)
  WHERE action LIKE '%export%' OR entity_type='export_job';
