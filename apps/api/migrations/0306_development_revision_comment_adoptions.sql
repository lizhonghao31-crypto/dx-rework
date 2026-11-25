-- An ordinary workbench note is not a customer approval or an explicit rejection.
ALTER TABLE digital_development_final_comments
  DROP CONSTRAINT digital_development_final_comments_decision_check,
  ADD CONSTRAINT digital_development_final_comments_decision_check
    CHECK (decision IN ('approved','changes_required') OR (NOT is_final AND decision='noted'));

-- Store the original reference without adding it to the revision's file list.
CREATE TABLE digital_development_revision_comment_adoptions (
  source_id uuid NOT NULL REFERENCES digital_production_sources(source_id),
  round_number integer NOT NULL CHECK (round_number>0),
  based_on_source_id uuid NOT NULL,
  based_on_round integer NOT NULL CHECK (based_on_round>0),
  based_on_scope text NOT NULL,
  comment_id uuid NOT NULL UNIQUE,
  comment_version integer NOT NULL CHECK (comment_version>0),
  adopted_by uuid NOT NULL REFERENCES app_users(id),
  PRIMARY KEY (source_id,round_number),
  FOREIGN KEY (comment_id,based_on_source_id,based_on_round,based_on_scope,comment_version)
    REFERENCES digital_development_final_comments(comment_id,source_id,round_number,scope_ref,version),
  CHECK (source_id<>based_on_source_id OR round_number>based_on_round)
);

CREATE TRIGGER digital_development_revision_comment_adoptions_immutable
  BEFORE UPDATE OR DELETE ON digital_development_revision_comment_adoptions
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();

-- Only native formal creation can opt in to the four-receipt milestone. An
-- existing order and its previous milestone are not converted by installing it.
CREATE TABLE digital_development_formal_handover_enrollments (
  production_order_id uuid PRIMARY KEY REFERENCES digital_production_orders(production_order_id),
  source_id uuid NOT NULL REFERENCES digital_production_sources(source_id),
  creation_event_id uuid NOT NULL REFERENCES audit_events(id)
);

CREATE TRIGGER digital_development_formal_handover_enrollments_immutable
  BEFORE UPDATE OR DELETE ON digital_development_formal_handover_enrollments
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
