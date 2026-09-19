-- Cutting sheet evidence is mandatory for new cutting registrations.
-- Historical records remain readable with an empty attachment_ids array.

ALTER TABLE cutting_records
  ADD COLUMN attachment_ids uuid[] NOT NULL DEFAULT ARRAY[]::uuid[];

ALTER TABLE cutting_records
  ADD CONSTRAINT cutting_records_attachment_count
  CHECK(cardinality(attachment_ids) BETWEEN 0 AND 3);

CREATE OR REPLACE FUNCTION guard_cutting_record_creation()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  event operation_events%ROWTYPE;
  source_formal_style text;
  source_active boolean;
  attachment_count integer;
  distinct_attachment_count integer;
BEGIN
  SELECT * INTO event FROM operation_events WHERE event_id=NEW.operation_event_id;
  SELECT line.formal_style_no,source_case.deleted_at IS NULL
  INTO source_formal_style,source_active
  FROM cutting_orders cutting
  JOIN sourcing_cases source_case
    ON source_case.sourcing_case_id=cutting.sourcing_case_id
  JOIN current_sourcing_case_lines line
    ON line.sourcing_case_id=cutting.sourcing_case_id
   AND line.position=cutting.sourcing_line_position
  WHERE cutting.cutting_order_id=NEW.cutting_order_id;

  IF source_active IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'cutting record requires active source case'
      USING ERRCODE='23514';
  END IF;

  IF cardinality(NEW.attachment_ids) NOT BETWEEN 1 AND 3 THEN
    RAISE EXCEPTION 'cutting record requires between one and three cutting sheet images'
      USING ERRCODE='23514';
  END IF;

  SELECT count(*),count(DISTINCT ids.attachment_id)
  INTO attachment_count,distinct_attachment_count
  FROM unnest(NEW.attachment_ids) AS ids(attachment_id);

  IF attachment_count<>distinct_attachment_count THEN
    RAISE EXCEPTION 'cutting sheet images cannot be duplicated'
      USING ERRCODE='23505';
  END IF;

  SELECT count(*) INTO attachment_count
  FROM attachments attachment
  WHERE attachment.attachment_id=ANY(NEW.attachment_ids)
    AND attachment.status='ready'
    AND attachment.uploaded_by=NEW.recorded_by
    AND attachment.entity_type IS NULL
    AND attachment.entity_id IS NULL
    AND attachment.mime_type IN ('image/jpeg','image/png','image/webp');

  IF attachment_count<>cardinality(NEW.attachment_ids) THEN
    RAISE EXCEPTION 'cutting sheet images must be ready owned unbound images'
      USING ERRCODE='23514';
  END IF;

  IF event.event_id IS NULL
    OR event.action<>'cutting.record.create'
    OR event.entity_type<>'cutting_order'
    OR event.entity_id<>NEW.cutting_order_id::text
    OR event.actor_id<>NEW.recorded_by
    OR event.request_id<>NEW.request_id
    OR event.authorization_capability<>'cutting:records:create'
    OR NOT (
      event.actor_roles @> ARRAY['root_superuser']::text[]
      OR event.actor_roles @> ARRAY['cutting_supervisor']::text[]
      OR event.actor_roles @> ARRAY['cutting_worker']::text[]
    )
    OR (event.after_state->>'pieceCount')::numeric IS DISTINCT FROM NEW.piece_count
    OR (event.after_state->>'actualCutCount')::numeric IS DISTINCT FROM NEW.actual_cut_count
    OR event.after_state->'attachmentIds' IS DISTINCT FROM to_jsonb(NEW.attachment_ids)
  THEN
    RAISE EXCEPTION 'cutting record requires matching authorized audit'
      USING ERRCODE='55000';
  END IF;

  IF source_formal_style IS NULL OR btrim(source_formal_style)='' THEN
    RAISE EXCEPTION 'cutting record requires current formal style number'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION guard_cutting_attachment_binding()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  record_row cutting_records%ROWTYPE;
  event operation_events%ROWTYPE;
BEGIN
  IF OLD.entity_type='cutting_record' THEN
    IF NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'bound cutting sheet image is immutable'
        USING ERRCODE='55000';
    END IF;
    RETURN NEW;
  END IF;

  IF (OLD.entity_type,OLD.entity_id) IS NOT DISTINCT FROM (NEW.entity_type,NEW.entity_id)
     OR (OLD.entity_type IS DISTINCT FROM 'cutting_record'
         AND NEW.entity_type IS DISTINCT FROM 'cutting_record')
  THEN
    RETURN NEW;
  END IF;

  IF NOT (
    OLD.entity_type IS NULL
    AND OLD.entity_id IS NULL
    AND NEW.entity_type='cutting_record'
    AND NEW.entity_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'cutting sheet images cannot be moved or unbound'
      USING ERRCODE='23514';
  END IF;

  SELECT * INTO record_row
  FROM cutting_records
  WHERE cutting_record_id=NEW.entity_id::uuid;

  IF record_row.cutting_record_id IS NULL THEN
    RAISE EXCEPTION 'cutting record does not exist for image binding'
      USING ERRCODE='23514';
  END IF;

  SELECT * INTO event
  FROM operation_events
  WHERE event_id=record_row.operation_event_id;

  IF NEW.status<>'ready'
    OR NEW.uploaded_by<>record_row.recorded_by
    OR NEW.mime_type NOT IN ('image/jpeg','image/png','image/webp')
    OR NOT (NEW.attachment_id=ANY(record_row.attachment_ids))
    OR event.event_id IS NULL
    OR event.action<>'cutting.record.create'
    OR event.entity_type<>'cutting_order'
    OR event.entity_id<>record_row.cutting_order_id::text
    OR event.actor_id<>record_row.recorded_by
    OR event.request_id<>record_row.request_id
    OR NOT (event.after_state->'attachmentIds' ? NEW.attachment_id::text)
  THEN
    RAISE EXCEPTION 'cutting sheet image binding requires matching recorded audit'
      USING ERRCODE='55000';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER attachments_cutting_binding_guard
  BEFORE UPDATE ON attachments
  FOR EACH ROW EXECUTE FUNCTION guard_cutting_attachment_binding();
