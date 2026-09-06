-- Financial before/after values must not enter the general technical audit API.
CREATE TABLE sample_financial_audit (
 event_id uuid PRIMARY KEY REFERENCES operation_events(event_id),
 sample_id uuid NOT NULL REFERENCES sample_items(sample_id),
 before_state jsonb CHECK(before_state IS NULL OR jsonb_typeof(before_state)='object'),
 after_state jsonb NOT NULL CHECK(jsonb_typeof(after_state)='object'),
 created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX sample_financial_audit_history_idx ON sample_financial_audit(sample_id,created_at,event_id);
CREATE TRIGGER sample_financial_audit_no_update BEFORE UPDATE ON sample_financial_audit
 FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER sample_financial_audit_no_delete BEFORE DELETE ON sample_financial_audit
 FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER sample_financial_audit_no_truncate BEFORE TRUNCATE ON sample_financial_audit
 FOR EACH STATEMENT EXECUTE FUNCTION reject_operation_event_mutation();
