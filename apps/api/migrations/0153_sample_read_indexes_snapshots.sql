-- Sample-only indexes and event-time actor snapshots. No external database extension required.
CREATE INDEX sample_code_prefix_idx ON sample_items(upper(sample_code) text_pattern_ops);
CREATE INDEX sample_style_prefix_idx ON sample_items(upper(style_no) text_pattern_ops);
CREATE INDEX sample_disposal_effective_date_idx ON sample_disposals((COALESCE(paid_at,approved_at)),sample_id)
 WHERE approved_at IS NOT NULL;
CREATE INDEX sample_disposal_sample_idx ON sample_disposals(sample_id);

ALTER TABLE sample_workflow_requests ADD COLUMN requested_by_name text;
UPDATE sample_workflow_requests SET requested_by_name='历史申请人（未留存当时姓名）';
ALTER TABLE sample_workflow_requests ALTER COLUMN requested_by_name SET NOT NULL;
CREATE FUNCTION sample_request_actor_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN
   SELECT display_name INTO NEW.requested_by_name FROM app_users WHERE id=NEW.requested_by;
 ELSE
   IF NEW.requested_by IS DISTINCT FROM OLD.requested_by OR NEW.requested_by_name IS DISTINCT FROM OLD.requested_by_name THEN
     RAISE EXCEPTION 'sample request actor snapshot is immutable' USING ERRCODE='55000';
   END IF;
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER sample_request_actor_snapshot BEFORE INSERT OR UPDATE ON sample_workflow_requests
 FOR EACH ROW EXECUTE FUNCTION sample_request_actor_snapshot();

CREATE TABLE sample_event_actor_snapshots (
 event_id uuid PRIMARY KEY REFERENCES operation_events(event_id),
 actor_id uuid NOT NULL REFERENCES app_users(id), actor_name text NOT NULL
);
CREATE FUNCTION sample_capture_event_actor() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.entity_type='sample' THEN
   INSERT INTO sample_event_actor_snapshots(event_id,actor_id,actor_name)
   SELECT NEW.event_id,NEW.actor_id,display_name FROM app_users WHERE id=NEW.actor_id;
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER sample_capture_event_actor AFTER INSERT ON operation_events
 FOR EACH ROW WHEN (NEW.entity_type='sample') EXECUTE FUNCTION sample_capture_event_actor();
CREATE TRIGGER sample_event_actor_no_update_delete BEFORE UPDATE OR DELETE ON sample_event_actor_snapshots
 FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER sample_event_actor_no_truncate BEFORE TRUNCATE ON sample_event_actor_snapshots
 FOR EACH STATEMENT EXECUTE FUNCTION reject_operation_event_mutation();
