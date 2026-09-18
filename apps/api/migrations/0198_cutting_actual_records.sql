-- Cutting actual-recording foundation. Append-only facts; no historical cutting backfill.

ALTER TABLE capability_catalog DISABLE TRIGGER capability_catalog_no_insert;
INSERT INTO capability_catalog(capability,display_name,description) VALUES
 ('cutting:records:correct','修正裁床实裁','仅 Root 追加式纠正已登记裁片数与实裁数')
ON CONFLICT DO NOTHING;
ALTER TABLE capability_catalog ENABLE TRIGGER capability_catalog_no_insert;

CREATE TABLE cutting_records (
  cutting_record_id uuid PRIMARY KEY,
  cutting_order_id uuid NOT NULL UNIQUE REFERENCES cutting_orders(cutting_order_id),
  piece_count bigint NOT NULL CHECK(piece_count>=0),
  actual_cut_count bigint NOT NULL CHECK(actual_cut_count>=0),
  recorded_by uuid NOT NULL REFERENCES app_users(id),
  operation_event_id uuid NOT NULL UNIQUE REFERENCES operation_events(event_id),
  request_id text NOT NULL CHECK(request_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  recorded_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX cutting_records_recorded_at_idx
  ON cutting_records(recorded_at DESC,cutting_order_id);

CREATE TABLE cutting_record_corrections (
  cutting_correction_id uuid PRIMARY KEY,
  cutting_record_id uuid NOT NULL REFERENCES cutting_records(cutting_record_id),
  correction_version integer NOT NULL CHECK(correction_version>0),
  piece_count bigint NOT NULL CHECK(piece_count>=0),
  actual_cut_count bigint NOT NULL CHECK(actual_cut_count>=0),
  reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 500),
  corrected_by uuid NOT NULL REFERENCES app_users(id),
  operation_event_id uuid NOT NULL UNIQUE REFERENCES operation_events(event_id),
  request_id text NOT NULL CHECK(request_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  corrected_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(cutting_record_id,correction_version)
);
CREATE INDEX cutting_record_corrections_record_idx
  ON cutting_record_corrections(cutting_record_id,correction_version DESC);

CREATE OR REPLACE FUNCTION guard_cutting_record_creation()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE event operation_events%ROWTYPE; source_formal_style text; source_active boolean;
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

CREATE OR REPLACE FUNCTION guard_cutting_record_correction()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE event operation_events%ROWTYPE; expected_version integer; source_active boolean;
BEGIN
  SELECT * INTO event FROM operation_events WHERE event_id=NEW.operation_event_id;
  SELECT source_case.deleted_at IS NULL INTO source_active
  FROM cutting_records record
  JOIN cutting_orders cutting ON cutting.cutting_order_id=record.cutting_order_id
  JOIN sourcing_cases source_case ON source_case.sourcing_case_id=cutting.sourcing_case_id
  WHERE record.cutting_record_id=NEW.cutting_record_id;
  IF source_active IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'cutting correction requires active source case'
      USING ERRCODE='23514';
  END IF;

  SELECT COALESCE(max(correction_version),0)+1 INTO expected_version
  FROM cutting_record_corrections WHERE cutting_record_id=NEW.cutting_record_id;

  IF NEW.correction_version<>expected_version
    OR event.event_id IS NULL
    OR event.action<>'cutting.record.correct'
    OR event.entity_type<>'cutting_record'
    OR event.entity_id<>NEW.cutting_record_id::text
    OR event.actor_id<>NEW.corrected_by
    OR event.request_id<>NEW.request_id
    OR event.authorization_capability<>'cutting:records:correct'
    OR NOT (event.actor_roles @> ARRAY['root_superuser']::text[])
    OR event.reason IS DISTINCT FROM NEW.reason
    OR (event.after_state->>'pieceCount')::numeric IS DISTINCT FROM NEW.piece_count
    OR (event.after_state->>'actualCutCount')::numeric IS DISTINCT FROM NEW.actual_cut_count
  THEN
    RAISE EXCEPTION 'cutting correction requires matching root audit and current version'
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER cutting_records_guard_creation
  BEFORE INSERT ON cutting_records
  FOR EACH ROW EXECUTE FUNCTION guard_cutting_record_creation();
CREATE TRIGGER cutting_records_no_update
  BEFORE UPDATE ON cutting_records
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER cutting_records_no_delete
  BEFORE DELETE ON cutting_records
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER cutting_records_no_truncate
  BEFORE TRUNCATE ON cutting_records
  FOR EACH STATEMENT EXECUTE FUNCTION reject_operation_event_mutation();

CREATE TRIGGER cutting_record_corrections_guard_creation
  BEFORE INSERT ON cutting_record_corrections
  FOR EACH ROW EXECUTE FUNCTION guard_cutting_record_correction();
CREATE TRIGGER cutting_record_corrections_no_update
  BEFORE UPDATE ON cutting_record_corrections
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER cutting_record_corrections_no_delete
  BEFORE DELETE ON cutting_record_corrections
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER cutting_record_corrections_no_truncate
  BEFORE TRUNCATE ON cutting_record_corrections
  FOR EACH STATEMENT EXECUTE FUNCTION reject_operation_event_mutation();

CREATE VIEW current_cutting_records AS
SELECT record.cutting_record_id,record.cutting_order_id,
       1+COALESCE(latest.correction_version,0) AS version,
       COALESCE(latest.piece_count,record.piece_count) AS piece_count,
       COALESCE(latest.actual_cut_count,record.actual_cut_count) AS actual_cut_count,
       record.piece_count AS initial_piece_count,
       record.actual_cut_count AS initial_actual_cut_count,
       record.recorded_by,record.recorded_at,
       latest.correction_version IS NOT NULL AS corrected,
       latest.corrected_at AS last_corrected_at
FROM cutting_records record
LEFT JOIN LATERAL (
  SELECT correction.correction_version,correction.piece_count,
         correction.actual_cut_count,correction.corrected_at
  FROM cutting_record_corrections correction
  WHERE correction.cutting_record_id=record.cutting_record_id
  ORDER BY correction.correction_version DESC
  LIMIT 1
) latest ON true;

CREATE VIEW current_cutting_style_options AS
SELECT eligible.*,
       count(*) OVER (PARTITION BY eligible.normalized_formal_style_no) AS style_conflict_count
FROM (
  SELECT cutting.cutting_order_id,cutting.sourcing_case_id,
         cutting.sourcing_line_position,
         line.formal_style_no,
         lower(btrim(line.formal_style_no)) AS normalized_formal_style_no,
         line.color,
         current_record.actual_cut_count,
         COALESCE(decision.supplier_id,snapshot.supplier_id) AS supplier_id,
         COALESCE(decision.supplier_name_snapshot,snapshot.supplier_name_snapshot) AS supplier_name
  FROM cutting_orders cutting
  JOIN sourcing_cases source_case
    ON source_case.sourcing_case_id=cutting.sourcing_case_id
   AND source_case.deleted_at IS NULL
  JOIN current_sourcing_case_lines line
    ON line.sourcing_case_id=cutting.sourcing_case_id
   AND line.position=cutting.sourcing_line_position
  JOIN current_cutting_records current_record
    ON current_record.cutting_order_id=cutting.cutting_order_id
  JOIN sourcing_approval_snapshots snapshot
    ON snapshot.sourcing_approval_snapshot_id=cutting.approval_snapshot_id
  LEFT JOIN LATERAL (
    SELECT current_decision.supplier_id,current_decision.supplier_name_snapshot
    FROM sourcing_decisions current_decision
    WHERE current_decision.sourcing_case_id=cutting.sourcing_case_id
    ORDER BY current_decision.decision_version DESC
    LIMIT 1
  ) decision ON true
  WHERE line.formal_style_no IS NOT NULL
    AND btrim(line.formal_style_no)<>''
) eligible;
