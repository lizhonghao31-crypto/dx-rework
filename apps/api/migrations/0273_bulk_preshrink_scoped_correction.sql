-- An explicit correction for the one approved legacy v3 preparation; no historical UPDATE.
CREATE TABLE digital_bulk_preshrink_corrections (
 correction_id uuid PRIMARY KEY,
 production_order_id uuid NOT NULL REFERENCES digital_production_orders(production_order_id),
 preparation_id uuid NOT NULL UNIQUE REFERENCES digital_bulk_preparations(preparation_id),
 instruction_version integer NOT NULL CHECK (instruction_version=3),
 source_id uuid NOT NULL REFERENCES digital_production_sources(source_id),
 source_round integer NOT NULL CHECK (source_round>0),
 sla_snapshot_id uuid NOT NULL REFERENCES digital_sla_order_snapshots(snapshot_id),
 pattern_task_id uuid NOT NULL REFERENCES digital_production_tasks(task_id),
 pattern_fact_id uuid NOT NULL REFERENCES digital_bulk_preparation_facts(fact_id),
 marker_fact_id uuid NOT NULL REFERENCES digital_bulk_preparation_facts(fact_id),
 preshrink_task_id uuid NOT NULL UNIQUE REFERENCES digital_production_tasks(task_id),
 no_preshrink_fact_id uuid NOT NULL UNIQUE REFERENCES digital_bulk_preparation_facts(fact_id),
 cancellation_event_id uuid NOT NULL UNIQUE REFERENCES digital_production_task_events(event_id),
 audit_event_id uuid NOT NULL UNIQUE REFERENCES audit_events(id),
 actor_id uuid NOT NULL REFERENCES app_users(id),
 expected_fingerprint text NOT NULL CHECK (expected_fingerprint ~ '^[a-f0-9]{64}$'),
 reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 1000),
 recorded_at timestamptz NOT NULL,
 FOREIGN KEY(production_order_id,instruction_version) REFERENCES digital_instruction_versions(production_order_id,version),
 CHECK (production_order_id='c05e324b-53b9-4fc0-ba0f-65c27eb0a245'::uuid),
 CHECK (pattern_task_id<>preshrink_task_id AND pattern_fact_id<>marker_fact_id)
);

CREATE TABLE digital_bulk_preshrink_correction_ranges (
 correction_id uuid NOT NULL REFERENCES digital_bulk_preshrink_corrections(correction_id),
 range_id uuid NOT NULL REFERENCES digital_bulk_work_ranges(range_id),
 kind text NOT NULL CHECK (kind IN ('纸样完成','唛架完成')),
 version integer NOT NULL CHECK (version>0),
 PRIMARY KEY(correction_id,range_id),
 UNIQUE(correction_id,kind,version)
);

CREATE FUNCTION guard_scoped_bulk_preshrink_correction() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP<>'INSERT' THEN
  RAISE EXCEPTION 'Scoped preshrink correction history is immutable';
 END IF;
 IF TG_TABLE_NAME='digital_bulk_preshrink_correction_ranges' THEN
  IF NOT EXISTS(SELECT 1 FROM digital_bulk_preshrink_corrections c JOIN digital_bulk_work_ranges r ON r.preparation_id=c.preparation_id AND r.task_id=c.pattern_task_id
    WHERE c.correction_id=NEW.correction_id AND r.range_id=NEW.range_id AND r.kind=NEW.kind AND r.version=NEW.version) THEN
   RAISE EXCEPTION 'Correction range does not belong to the frozen preparation';
  END IF;
  RETURN NEW;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM digital_bulk_preparations p
   JOIN digital_instruction_versions v ON v.production_order_id=p.production_order_id AND v.version=p.instruction_version
   JOIN digital_instruction_documents d ON d.production_order_id=p.production_order_id AND d.published_version=p.instruction_version
   JOIN digital_sla_order_snapshots s ON s.snapshot_id=p.sla_snapshot_id AND s.production_order_id=p.production_order_id
   WHERE p.preparation_id=NEW.preparation_id AND p.production_order_id=NEW.production_order_id
    AND p.instruction_version=NEW.instruction_version AND p.source_id=NEW.source_id AND p.source_round=NEW.source_round
    AND v.source_round=NEW.source_round AND p.sla_snapshot_id=NEW.sla_snapshot_id
    AND p.workflow_version=2 AND p.preshrink='需要预缩' AND v.document->>'preshrink'='无需预缩') THEN
  RAISE EXCEPTION 'Correction must reference the approved frozen v3 mismatch';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM digital_production_tasks p JOIN digital_production_task_access a USING(task_id)
   WHERE p.task_id=NEW.pattern_task_id AND p.route_instance_id=NEW.preparation_id AND p.route_version=NEW.instruction_version
    AND a.production_order_id=NEW.production_order_id AND a.task_kind='bulk_pattern' AND p.state='completed')
 OR NOT EXISTS(SELECT 1 FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id)
   WHERE t.task_id=NEW.preshrink_task_id AND t.route_instance_id=NEW.preparation_id AND t.route_version=NEW.instruction_version
    AND a.production_order_id=NEW.production_order_id AND a.task_kind='warehouse_preshrink' AND t.state='cancelled' AND t.completed_at IS NULL)
 OR EXISTS(SELECT 1 FROM digital_bulk_preparation_facts WHERE preparation_id=NEW.preparation_id AND kind='预缩完成')
 OR EXISTS(SELECT 1 FROM digital_production_task_events WHERE task_id=NEW.preshrink_task_id AND event_kind='completed') THEN
  RAISE EXCEPTION 'Correction cannot replace actual work or cancel another task';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM digital_bulk_preparation_facts WHERE fact_id=NEW.pattern_fact_id AND preparation_id=NEW.preparation_id AND task_id=NEW.pattern_task_id AND kind='纸样完成')
 OR NOT EXISTS(SELECT 1 FROM digital_bulk_preparation_facts WHERE fact_id=NEW.marker_fact_id AND preparation_id=NEW.preparation_id AND task_id=NEW.pattern_task_id AND kind='唛架完成')
 OR NOT EXISTS(SELECT 1 FROM digital_bulk_preparation_facts WHERE fact_id=NEW.no_preshrink_fact_id AND preparation_id=NEW.preparation_id AND task_id IS NULL AND kind='无需预缩' AND actor_id=NEW.actor_id) THEN
  RAISE EXCEPTION 'Correction facts do not match the original preparation';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM digital_production_task_events e JOIN digital_production_event_intents i USING(event_id)
   WHERE e.event_id=NEW.cancellation_event_id AND e.task_id=NEW.preshrink_task_id AND i.task_id=e.task_id
    AND e.event_kind='cancelled' AND i.event_kind=e.event_kind AND e.actor_id=NEW.actor_id
    AND e.resource_kind='order' AND e.resource_id=NEW.production_order_id
    AND e.payload->>'correctionId'=NEW.correction_id::text)
 OR NOT EXISTS(SELECT 1 FROM audit_events a WHERE a.id=NEW.audit_event_id AND a.actor_id=NEW.actor_id
   AND a.action='digital_bulk_preshrink_corrected' AND a.entity_type='digital_bulk_preparation'
   AND a.entity_id=NEW.production_order_id::text AND a.after_state->>'correctionId'=NEW.correction_id::text) THEN
  RAISE EXCEPTION 'Correction cancellation, intent and audit must be one operation';
 END IF;
 RETURN NEW;
END;
$$;

CREATE TRIGGER digital_bulk_preshrink_correction_guard BEFORE INSERT OR UPDATE OR DELETE ON digital_bulk_preshrink_corrections
 FOR EACH ROW EXECUTE FUNCTION guard_scoped_bulk_preshrink_correction();
CREATE TRIGGER digital_bulk_preshrink_correction_ranges_guard BEFORE INSERT OR UPDATE OR DELETE ON digital_bulk_preshrink_correction_ranges
 FOR EACH ROW EXECUTE FUNCTION guard_scoped_bulk_preshrink_correction();
CREATE TRIGGER digital_bulk_preshrink_correction_no_truncate BEFORE TRUNCATE ON digital_bulk_preshrink_corrections
 FOR EACH STATEMENT EXECUTE FUNCTION guard_scoped_bulk_preshrink_correction();
CREATE TRIGGER digital_bulk_preshrink_correction_ranges_no_truncate BEFORE TRUNCATE ON digital_bulk_preshrink_correction_ranges
 FOR EACH STATEMENT EXECUTE FUNCTION guard_scoped_bulk_preshrink_correction();
