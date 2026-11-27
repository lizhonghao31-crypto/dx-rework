-- Separate designer corrections from returned clerk tasks without altering old versions.
ALTER TABLE digital_development_amendments
 ADD COLUMN amendment_kind text NOT NULL DEFAULT 'returned_task',
 ADD COLUMN correction_event_id uuid UNIQUE REFERENCES audit_events(id),
 ALTER COLUMN task_id DROP NOT NULL,
 ALTER COLUMN draft_version DROP NOT NULL;
ALTER TABLE digital_development_amendments ADD CONSTRAINT development_amendment_exact_kind CHECK (
 (amendment_kind='returned_task' AND task_id IS NOT NULL AND draft_version IS NOT NULL AND correction_event_id IS NULL)
 OR (amendment_kind='designer_correction' AND task_id IS NULL AND draft_version IS NULL AND correction_event_id IS NOT NULL)
);
-- A published preorder can later save current technical inputs as a newer draft.
-- Its immutable procurement publication and intervening designer versions remain readable.
CREATE OR REPLACE VIEW digital_development_effective_documents AS
SELECT d.source_id,COALESCE(a.document_version,d.version) AS version,d.status,COALESCE(a.document,d.document) AS document,
 d.published_at,d.task_id,COALESCE(a.published_by,d.updated_by) AS updated_by,COALESCE(a.published_at,d.updated_at) AS updated_at
FROM digital_development_documents d LEFT JOIN LATERAL(
 SELECT * FROM digital_development_amendments WHERE source_id=d.source_id AND round_number=1 AND document_version>d.version
 ORDER BY document_version DESC LIMIT 1
)a ON true;

CREATE FUNCTION guard_development_designer_correction() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.amendment_kind='designer_correction' AND NOT EXISTS(
   SELECT 1 FROM audit_events e JOIN digital_production_sources s ON e.entity_id=s.source_id::text
   WHERE e.id=NEW.correction_event_id AND s.source_id=NEW.source_id AND e.actor_id=NEW.published_by
    AND (e.actor_id=s.created_by OR access_is_root_actor(e.actor_id))
    AND e.entity_type='digital_development' AND e.action='development_designer_correction'
    AND e.before_state->>'version'=NEW.base_document_version::text
    AND e.after_state->>'version'=NEW.document_version::text AND e.after_state->>'round'=NEW.round_number::text
    AND e.after_state->'changes'=NEW.changes AND e.after_state->>'reason'=NEW.reason
    AND e.xmin::text=(txid_current()%4294967296)::text
 ) THEN RAISE EXCEPTION 'designer correction requires its exact source and audit' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER development_designer_correction_evidence BEFORE INSERT ON digital_development_amendments
 FOR EACH ROW EXECUTE FUNCTION guard_development_designer_correction();
