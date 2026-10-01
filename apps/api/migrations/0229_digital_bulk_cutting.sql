-- Only completion identity is stored here. Quantities remain in original cutting records/corrections.
INSERT INTO digital_production_deadline_policies(node_key,version,label,sla_seconds,warning_ratio) VALUES('bulk_cutting_external',1,'外厂整款开裁',NULL,0.8);
CREATE TABLE digital_bulk_cutting_completions(
 preparation_id uuid PRIMARY KEY REFERENCES digital_bulk_preparations(preparation_id),
 production_order_id uuid NOT NULL REFERENCES digital_production_orders(production_order_id),
 task_id uuid NOT NULL UNIQUE REFERENCES digital_production_tasks(task_id),
 completed_by uuid NOT NULL REFERENCES app_users(id),completed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TRIGGER digital_bulk_cutting_completion_immutable BEFORE UPDATE OR DELETE ON digital_bulk_cutting_completions FOR EACH ROW EXECUTE FUNCTION guard_production_order_root_immutable();
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
      OR (event.actor_roles @> ARRAY['order_merchandiser']::text[] AND EXISTS(
        SELECT 1 FROM cutting_orders c JOIN sourcing_cases s USING(sourcing_case_id)
        JOIN digital_production_child_links l ON l.module='sourcing' AND l.child_id=c.sourcing_case_id
        JOIN digital_production_orders o USING(production_order_id)
        WHERE c.cutting_order_id=NEW.cutting_order_id AND s.workflow_generation='digital_production_v1'
          AND o.primary_merchandiser_id=event.actor_id
          AND (SELECT cutting_process FROM sourcing_decisions WHERE sourcing_case_id=s.sourcing_case_id ORDER BY decision_version DESC LIMIT 1)='outsourced'
      ))
    )
    OR (event.after_state->>'pieceCount')::numeric IS DISTINCT FROM NEW.piece_count
    OR (event.after_state->>'actualCutCount')::numeric IS DISTINCT FROM NEW.actual_cut_count
    OR event.after_state->'attachmentIds' IS DISTINCT FROM to_jsonb(NEW.attachment_ids)
  THEN
    RAISE EXCEPTION 'cutting record requires matching authorized audit'
      USING ERRCODE='55000';
  END IF;

  IF (source_formal_style IS NULL OR btrim(source_formal_style)='') AND NOT EXISTS(
    SELECT 1 FROM cutting_orders c JOIN sourcing_cases s USING(sourcing_case_id)
    JOIN digital_production_child_links l ON l.module='sourcing' AND l.child_id=c.sourcing_case_id
    JOIN digital_instruction_documents d ON d.production_order_id=l.production_order_id
    JOIN digital_bulk_preparations p ON p.production_order_id=l.production_order_id AND p.instruction_version=d.published_version
    JOIN digital_production_tasks t ON t.route_instance_id=p.preparation_id
    WHERE c.cutting_order_id=NEW.cutting_order_id AND s.workflow_generation='digital_production_v1'
      AND t.node_key IN ('bulk_cutting','bulk_cutting_external') AND t.state='ready'
  ) THEN
    RAISE EXCEPTION 'cutting record requires current formal style number'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION guard_sourcing_style_revision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source sourcing_cases%ROWTYPE; event operation_events%ROWTYPE; entry jsonb;
BEGIN
  SELECT * INTO source FROM sourcing_cases WHERE sourcing_case_id=NEW.sourcing_case_id FOR UPDATE;
  SELECT * INTO event FROM operation_events WHERE event_id=NEW.operation_event_id;
  IF source.sourcing_case_id IS NULL OR source.deleted_at IS NOT NULL
    OR NEW.revision<>(SELECT COALESCE(max(revision),0)+1 FROM sourcing_style_revisions WHERE sourcing_case_id=NEW.sourcing_case_id)
    OR event.event_id IS NULL OR event.action<>'sourcing.styles.revise'
    OR event.entity_type<>'sourcing_case' OR event.entity_id<>NEW.sourcing_case_id::text
    OR event.actor_id<>NEW.changed_by OR event.request_id<>NEW.request_id
    OR event.after_state->'lines' IS DISTINCT FROM NEW.lines
    OR NOT (event.actor_roles @> ARRAY['root_superuser']::text[]
      OR (event.actor_roles @> ARRAY['production_management']::text[] AND event.authorization_capability='sourcing:decision:record')
      OR (event.actor_roles @> ARRAY['order_merchandiser']::text[] AND event.actor_id=source.created_by
        AND event.authorization_capability='sourcing:inquiry:create')
      OR (source.workflow_generation='digital_production_v1' AND event.authorization_capability='digital_production:numbers:correct' AND EXISTS(
        SELECT 1 FROM digital_production_child_links l JOIN digital_production_orders o USING(production_order_id)
        WHERE l.module='sourcing' AND l.child_id=NEW.sourcing_case_id AND (
          event.actor_roles && ARRAY['owner_group','production_management']::text[]
          OR (event.actor_roles @> ARRAY['sample_designer']::text[] AND o.created_by=event.actor_id)
          OR (event.actor_roles @> ARRAY['order_merchandiser']::text[] AND o.primary_merchandiser_id=event.actor_id)
        )
      )))
  THEN RAISE EXCEPTION 'style revision requires current version and authorized audit' USING ERRCODE='55000'; END IF;
  IF jsonb_array_length(NEW.lines)<>(SELECT count(*) FROM sourcing_case_lines WHERE sourcing_case_id=NEW.sourcing_case_id)
    OR (SELECT count(DISTINCT value->>'position') FROM jsonb_array_elements(NEW.lines))<>jsonb_array_length(NEW.lines)
  THEN RAISE EXCEPTION 'style revision must cover exactly the existing lines' USING ERRCODE='55000'; END IF;
  FOR entry IN SELECT value FROM jsonb_array_elements(NEW.lines) LOOP
    IF jsonb_typeof(entry)<>'object' OR entry-ARRAY['position','styleNo','alternateStyleNo']<>'{}'::jsonb
      OR NOT EXISTS(SELECT 1 FROM sourcing_case_lines WHERE sourcing_case_id=NEW.sourcing_case_id AND position=(entry->>'position')::integer)
      OR (nullif(btrim(entry->>'styleNo'),'') IS NULL AND nullif(btrim(entry->>'alternateStyleNo'),'') IS NULL)
      OR (entry->>'styleNo' IS NOT NULL AND length(btrim(entry->>'styleNo')) NOT BETWEEN 1 AND 100)
      OR (entry->>'alternateStyleNo' IS NOT NULL AND length(btrim(entry->>'alternateStyleNo')) NOT BETWEEN 1 AND 100)
    THEN RAISE EXCEPTION 'invalid style revision line' USING ERRCODE='55000'; END IF;
  END LOOP;
  RETURN NEW;
END; $$;
