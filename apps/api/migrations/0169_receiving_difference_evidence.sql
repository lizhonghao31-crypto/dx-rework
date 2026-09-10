-- Bind optional evidence to one immutable difference resolution, never to a delivery note.
CREATE FUNCTION guard_receiving_difference_evidence()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' AND OLD.entity_type='receiving_difference_resolution' THEN
    RAISE EXCEPTION 'difference resolution evidence is immutable' USING ERRCODE='55000';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  IF NEW.entity_type IS DISTINCT FROM 'receiving_difference_resolution' THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND (OLD.entity_type IS NOT NULL OR OLD.entity_id IS NOT NULL) THEN
    RAISE EXCEPTION 'difference evidence cannot replace another binding' USING ERRCODE='55000';
  END IF;
  IF NEW.status <> 'ready' OR NEW.mime_type NOT IN ('image/jpeg','image/png','image/webp')
     OR NOT EXISTS (
       SELECT 1 FROM receiving_difference_resolutions resolution
       JOIN operation_events event ON event.event_id=resolution.operation_event_id
       WHERE resolution.resolution_id::text=NEW.entity_id
         AND resolution.handled_by=NEW.uploaded_by
         AND event.after_state->'attachmentIds' @> jsonb_build_array(NEW.attachment_id::text)
     ) THEN
    RAISE EXCEPTION 'difference evidence requires ready owned image and matching resolution audit'
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER attachments_difference_evidence_guard
  BEFORE INSERT OR UPDATE OR DELETE ON attachments
  FOR EACH ROW EXECUTE FUNCTION guard_receiving_difference_evidence();
