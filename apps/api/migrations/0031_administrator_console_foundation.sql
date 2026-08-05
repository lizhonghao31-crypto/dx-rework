-- PR-15 batch 2: administrator console read-only/query foundations.
-- Adds administrator capabilities and supporting indexes only; existing facts
-- remain in their origin tables and immutable ledgers.

DROP TRIGGER capability_catalog_no_insert ON capability_catalog;
DROP TRIGGER role_capabilities_no_insert ON role_capabilities;

INSERT INTO capability_catalog(capability,display_name,description) VALUES
  ('admin:read','管理员后台查看','系统管理员查看审计、附件、代理授权和系统异常元数据'),
  ('admin:exception:manage','管理员异常处置','系统管理员对明确可安全重试的技术异常执行幂等重试')
ON CONFLICT DO NOTHING;

INSERT INTO role_capabilities(role_code,capability) VALUES
  ('system_admin','admin:read'),
  ('system_admin','admin:exception:manage')
ON CONFLICT DO NOTHING;

CREATE TRIGGER capability_catalog_no_insert
  BEFORE INSERT ON capability_catalog FOR EACH ROW
  EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER role_capabilities_no_insert
  BEFORE INSERT ON role_capabilities FOR EACH ROW
  EXECUTE FUNCTION reject_operation_event_mutation();

CREATE INDEX IF NOT EXISTS attachments_admin_seek_idx
  ON attachments(created_at DESC,attachment_id DESC);
CREATE INDEX IF NOT EXISTS attachments_admin_status_seek_idx
  ON attachments(status,created_at DESC,attachment_id DESC);
CREATE INDEX IF NOT EXISTS attachments_admin_uploader_seek_idx
  ON attachments(uploaded_by,created_at DESC,attachment_id DESC);
CREATE INDEX IF NOT EXISTS attachments_admin_entity_seek_idx
  ON attachments(entity_type,entity_id,created_at DESC,attachment_id DESC)
  WHERE entity_type IS NOT NULL;
CREATE INDEX IF NOT EXISTS delegated_authorizations_admin_seek_idx
  ON delegated_authorizations(created_at DESC,delegation_id DESC);
CREATE INDEX IF NOT EXISTS delegated_authorizations_admin_grantee_seek_idx
  ON delegated_authorizations(grantee_user_id,created_at DESC,delegation_id DESC);
CREATE INDEX IF NOT EXISTS delegated_authorizations_admin_scope_seek_idx
  ON delegated_authorizations(scope_type,scope_id,created_at DESC,delegation_id DESC);
CREATE INDEX IF NOT EXISTS message_outbox_admin_exception_idx
  ON message_outbox(status,updated_at DESC,event_id)
  WHERE status IN ('failed','processing');
CREATE INDEX IF NOT EXISTS export_jobs_admin_exception_idx
  ON export_jobs(status,updated_at DESC,export_job_id)
  WHERE status IN ('failed','running');
CREATE INDEX IF NOT EXISTS attachments_admin_pending_exception_idx
  ON attachments(status,created_at DESC,attachment_id)
  WHERE status='pending';
