CREATE TABLE digital_bulk_dispatch (
 production_order_id uuid PRIMARY KEY REFERENCES digital_production_orders(production_order_id),
 version integer NOT NULL DEFAULT 1 CHECK(version>0),
 pattern_worker_id uuid REFERENCES app_users(id), warehouse_worker_id uuid REFERENCES app_users(id), cutting_worker_id uuid REFERENCES app_users(id),
 changed_by uuid NOT NULL REFERENCES app_users(id), changed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE digital_bulk_preparations (
 preparation_id uuid PRIMARY KEY,
 production_order_id uuid NOT NULL REFERENCES digital_production_orders(production_order_id),
 instruction_version integer NOT NULL,
 approval_snapshot_id uuid NOT NULL REFERENCES sourcing_approval_snapshots(sourcing_approval_snapshot_id),
 source_id uuid NOT NULL REFERENCES digital_production_sources(source_id),source_round integer NOT NULL CHECK(source_round>0),
 preshrink text NOT NULL CHECK(preshrink IN ('需要预缩','无需预缩')),
 created_by uuid NOT NULL REFERENCES app_users(id),created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(production_order_id,instruction_version) REFERENCES digital_instruction_versions(production_order_id,version),
 UNIQUE(production_order_id,instruction_version,source_round)
);
CREATE TABLE digital_bulk_preparation_facts (
 fact_id uuid PRIMARY KEY, preparation_id uuid NOT NULL REFERENCES digital_bulk_preparations(preparation_id),
 kind text NOT NULL CHECK(kind IN ('纸样完成','唛架完成','预缩完成','无需预缩','纸样派交')),
 task_id uuid REFERENCES digital_production_tasks(task_id),actor_id uuid NOT NULL REFERENCES app_users(id),
 recorded_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(preparation_id,kind)
);
CREATE TRIGGER digital_bulk_preparation_immutable BEFORE UPDATE OR DELETE ON digital_bulk_preparations FOR EACH ROW EXECUTE FUNCTION guard_production_order_root_immutable();
CREATE TRIGGER digital_bulk_preparation_fact_immutable BEFORE UPDATE OR DELETE ON digital_bulk_preparation_facts FOR EACH ROW EXECUTE FUNCTION guard_production_order_root_immutable();

-- New approved/prepared digital orders may cut using their stable temporary identity.
-- Legacy formal-number and all image/audit/quantity safeguards remain unchanged.
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
