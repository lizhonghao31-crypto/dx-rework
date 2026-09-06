ALTER TABLE role_capabilities DISABLE TRIGGER role_capabilities_no_insert;
INSERT INTO role_capabilities(role_code,capability) VALUES
 ('sample_designer','todo:view'),('sample_administrative','todo:view'),('sample_finance','todo:view') ON CONFLICT DO NOTHING;
ALTER TABLE role_capabilities ENABLE TRIGGER role_capabilities_no_insert;

ALTER TABLE sample_workflow_requests ADD COLUMN requested_for_name text;
ALTER TABLE sample_workflow_requests ADD COLUMN department text NOT NULL DEFAULT '';
UPDATE sample_workflow_requests SET requested_for_name='历史持有人（未留存当时姓名）' WHERE requested_for IS NOT NULL;
CREATE FUNCTION sample_request_holder_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.requested_for IS NOT NULL THEN
   SELECT display_name INTO STRICT NEW.requested_for_name FROM app_users WHERE id=NEW.requested_for;
  END IF;
  SELECT department INTO STRICT NEW.department FROM sample_items WHERE sample_id=NEW.sample_id;
 ELSIF NEW.requested_for IS DISTINCT FROM OLD.requested_for OR NEW.requested_for_name IS DISTINCT FROM OLD.requested_for_name
   OR NEW.department IS DISTINCT FROM OLD.department THEN
  RAISE EXCEPTION 'sample request holder snapshots are immutable' USING ERRCODE='55000';
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER sample_request_holder_snapshot BEFORE INSERT OR UPDATE ON sample_workflow_requests
 FOR EACH ROW EXECUTE FUNCTION sample_request_holder_snapshot();

CREATE TABLE sample_handoff_challenges (
 token_hash text PRIMARY KEY CHECK(token_hash ~ '^[0-9a-f]{64}$'),
 request_id uuid NOT NULL REFERENCES sample_workflow_requests(request_id),
 subject_user_id uuid NOT NULL REFERENCES app_users(id),
 issued_by uuid NOT NULL REFERENCES app_users(id),
 expires_at timestamptz NOT NULL,used_at timestamptz,used_by uuid REFERENCES app_users(id),
 revoked_at timestamptz,created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK ((used_at IS NULL)=(used_by IS NULL))
);
CREATE INDEX sample_handoff_request_idx ON sample_handoff_challenges(request_id,expires_at);
CREATE TABLE sample_request_attachments (
 request_id uuid NOT NULL REFERENCES sample_workflow_requests(request_id),
 attachment_id uuid NOT NULL REFERENCES attachments(attachment_id),
 purpose text NOT NULL CHECK(purpose IN ('return_photo','disposal_proof','payment_proof')),
 PRIMARY KEY(request_id,attachment_id,purpose)
);
CREATE TRIGGER sample_request_attachments_no_update BEFORE UPDATE ON sample_request_attachments
 FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER sample_request_attachments_no_delete BEFORE DELETE ON sample_request_attachments
 FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER sample_request_attachments_no_truncate BEFORE TRUNCATE ON sample_request_attachments
 FOR EACH STATEMENT EXECUTE FUNCTION reject_operation_event_mutation();

ALTER TABLE rework_todos DROP CONSTRAINT rework_todos_route_descriptor_check;
ALTER TABLE rework_todos ADD CONSTRAINT rework_todos_route_descriptor_check CHECK(
 jsonb_typeof(route_descriptor)='object' AND route_descriptor ? 'routeName' AND route_descriptor ? 'entityId'
 AND route_descriptor->>'routeName' IN ('rework_detail','process_configuration','whole_order_review','responsibility_detail',
 'own_factory_approval','external_responsibility_detail','wage_period_detail','sourcing_detail','production_detail','sample_detail')
 AND length(btrim(route_descriptor->>'entityId'))>0
);
