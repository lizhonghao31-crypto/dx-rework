-- Minimal aggregate diagnostics: no identity, object, request, payload or credential columns.
CREATE TABLE work_operation_diagnostics (
 diagnostic_id uuid PRIMARY KEY,
 operation text NOT NULL CHECK(operation IN ('attachment_intent','attachment_finalize','sample_create','sample_batch_create','supplier_create','supplier_revision','sourcing_create','sourcing_ie_quote','sourcing_management_decision','sourcing_owner_decision','production_report','production_correction','receiving_record','receiving_repeat','receiving_correction','packing_revision','difference_resolution')),
 http_status integer NOT NULL CHECK(http_status BETWEEN 200 AND 599 AND http_status NOT BETWEEN 300 AND 399),
 outcome text NOT NULL CHECK(outcome IN ('success','validation','permission','technical')),
 error_code text NOT NULL CHECK(error_code IN ('OK','VALIDATION_ERROR','FORBIDDEN','NO_BUSINESS_ROLE','UNAUTHORIZED','NOT_FOUND','CONFLICT','VERSION_CONFLICT','INTERNAL_ERROR','IDEMPOTENCY_CONFLICT','ATTACHMENT_NOT_READY','ATTACHMENT_UPLOAD_INCOMPLETE','UNCLASSIFIED')),
 replayed boolean NOT NULL DEFAULT false CHECK(NOT replayed OR http_status<300),
 recorded_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK(outcome=CASE WHEN http_status>=500 THEN 'technical' WHEN http_status IN (401,403) THEN 'permission' WHEN http_status>=400 THEN 'validation' ELSE 'success' END)
);
CREATE INDEX work_operation_diagnostics_time_idx ON work_operation_diagnostics(recorded_at,operation,outcome);
CREATE INDEX work_analysis_events_history_idx ON operation_events(entity_type,entity_id,created_at,event_id) WHERE entity_type IN ('rework_order','sourcing_case');
CREATE TRIGGER work_diagnostics_no_update BEFORE UPDATE ON work_operation_diagnostics FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER work_diagnostics_no_delete BEFORE DELETE ON work_operation_diagnostics FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER work_diagnostics_no_truncate BEFORE TRUNCATE ON work_operation_diagnostics FOR EACH STATEMENT EXECUTE FUNCTION reject_operation_event_mutation();
