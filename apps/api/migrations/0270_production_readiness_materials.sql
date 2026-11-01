ALTER TABLE digital_development_technical_material_decisions ADD COLUMN preshrink_method text CHECK(preshrink_method IN ('专业针织预缩','常规梭织预缩','其它经技术确认'));
ALTER TABLE digital_series_source_events ADD COLUMN business_completed boolean NOT NULL DEFAULT true;
-- Native preparation evidence. Existing orders, instructions and completed clocks are not backfilled.
CREATE TABLE digital_preparation_rule_adoptions (
 adoption_id uuid PRIMARY KEY,resource_kind text NOT NULL CHECK(resource_kind IN ('source','order')),resource_id uuid NOT NULL,
 revision integer NOT NULL CHECK(revision>0),rule_version text NOT NULL CHECK(rule_version='production-readiness-20261101'),
 basis_revision text NOT NULL,reason text NOT NULL,standards jsonb NOT NULL,
 acknowledged_by uuid NOT NULL REFERENCES app_users(id),adopted_by uuid NOT NULL REFERENCES app_users(id),
 creation_event_id uuid REFERENCES audit_events(id),business_time jsonb NOT NULL,recorded_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(resource_kind,resource_id,revision)
);
CREATE TABLE digital_preparation_adoption_acknowledgements (
 acknowledgement_id uuid PRIMARY KEY,production_order_id uuid NOT NULL REFERENCES production_order_roots(production_order_id),
 basis_revision text NOT NULL,reason text NOT NULL,actor_id uuid NOT NULL REFERENCES app_users(id),
 business_time jsonb NOT NULL,recorded_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(production_order_id,basis_revision)
);
CREATE TABLE digital_preparation_responsibilities (
 resource_kind text NOT NULL CHECK(resource_kind IN ('source','order')),resource_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),
 warehouse_worker_id uuid REFERENCES app_users(id),color_confirmation_worker_id uuid REFERENCES app_users(id),color_confirmation_role text REFERENCES business_roles(role_code),
 reason text NOT NULL,actor_id uuid NOT NULL REFERENCES app_users(id),occurred_at timestamptz NOT NULL,
 PRIMARY KEY(resource_kind,resource_id,version),CHECK((color_confirmation_worker_id IS NULL)=(color_confirmation_role IS NULL))
);
CREATE TABLE digital_preparation_material_versions (
 record_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),
 resource_kind text NOT NULL CHECK(resource_kind IN ('source','order')),resource_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('design_handover','material_investment','fabric_receipt','color_confirmation','accessories_ready','style_label_ready')),
 scope_ref text NOT NULL CHECK(length(btrim(scope_ref)) BETWEEN 1 AND 150),
 state text NOT NULL CHECK(state IN ('ready','partial','unknown','withdrawn')),
 occurred_at timestamptz,body jsonb NOT NULL,actor_id uuid NOT NULL REFERENCES app_users(id),recorded_at timestamptz NOT NULL,
 PRIMARY KEY(record_id,version),UNIQUE(resource_kind,resource_id,kind,scope_ref,version),
 CHECK((state IN ('ready','partial'))=(occurred_at IS NOT NULL)),CHECK(jsonb_typeof(body)='object')
);
CREATE INDEX preparation_material_resource ON digital_preparation_material_versions(resource_kind,resource_id,kind,scope_ref,version DESC);
CREATE TABLE digital_preparation_windows (
 window_id uuid PRIMARY KEY,production_order_id uuid NOT NULL REFERENCES production_order_roots(production_order_id),
 kind text NOT NULL CHECK(kind IN ('draft','final')),epoch integer NOT NULL CHECK(epoch>0),
 adoption_id uuid NOT NULL REFERENCES digital_preparation_rule_adoptions(adoption_id),
 started_at timestamptz,due_at timestamptz,minutes integer NOT NULL CHECK(minutes>0),basis_json jsonb NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(production_order_id,kind,epoch),CHECK((started_at IS NULL)=(due_at IS NULL)),
 CHECK(due_at IS NULL OR due_at=started_at+minutes*interval '1 minute')
);
CREATE TABLE digital_preparation_instruction_events (
 event_id uuid PRIMARY KEY,production_order_id uuid NOT NULL REFERENCES production_order_roots(production_order_id),
 kind text NOT NULL CHECK(kind IN ('draft_saved','published')),instruction_version integer NOT NULL CHECK(instruction_version>0),
 occurred_at timestamptz NOT NULL,actor_id uuid NOT NULL REFERENCES app_users(id),body jsonb NOT NULL,
 UNIQUE(production_order_id,kind,instruction_version)
);
CREATE TABLE digital_instruction_preparation_bases (
 production_order_id uuid NOT NULL,instruction_version integer NOT NULL,
 readiness_revision text NOT NULL,technical_revision text NOT NULL,basis_json jsonb NOT NULL,
 PRIMARY KEY(production_order_id,instruction_version),
 FOREIGN KEY(production_order_id,instruction_version) REFERENCES digital_instruction_versions(production_order_id,version)
);
CREATE TABLE digital_instruction_deliveries (
 event_id uuid PRIMARY KEY,production_order_id uuid NOT NULL,instruction_version integer NOT NULL,
 recipient text NOT NULL CHECK(length(btrim(recipient)) BETWEEN 1 AND 200),occurred_at timestamptz NOT NULL,
 note text NOT NULL,evidence_ids uuid[] NOT NULL,actor_id uuid NOT NULL REFERENCES app_users(id),
 recorded_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(production_order_id,instruction_version) REFERENCES digital_instruction_versions(production_order_id,version)
);
ALTER TABLE digital_bulk_preparations ADD COLUMN supplement_of_preparation_id uuid REFERENCES digital_bulk_preparations(preparation_id), ADD COLUMN clock_origin_preparation_id uuid REFERENCES digital_bulk_preparations(preparation_id);
CREATE TABLE digital_bulk_work_ranges (
 range_id uuid PRIMARY KEY,preparation_id uuid NOT NULL REFERENCES digital_bulk_preparations(preparation_id),
 task_id uuid NOT NULL REFERENCES digital_production_tasks(task_id),kind text NOT NULL CHECK(kind IN ('纸样完成','唛架完成')),
 version integer NOT NULL CHECK(version>0),line_ids uuid[] NOT NULL,complete boolean NOT NULL,pending_material_ids uuid[] NOT NULL,
 note text NOT NULL,evidence_ids uuid[] NOT NULL,basis_json jsonb NOT NULL,actor_id uuid NOT NULL REFERENCES app_users(id),occurred_at timestamptz NOT NULL,
 UNIQUE(preparation_id,kind,version),CHECK(NOT complete OR cardinality(pending_material_ids)=0)
);
CREATE FUNCTION guard_preparation_evidence_identity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous digital_preparation_material_versions; origin audit_events;
BEGIN
 IF NEW.resource_kind='order' THEN
  IF NOT EXISTS(SELECT 1 FROM digital_production_orders WHERE production_order_id=NEW.resource_id) THEN RAISE EXCEPTION 'preparation order missing' USING ERRCODE='23514';END IF;
 ELSE
  IF NOT EXISTS(SELECT 1 FROM digital_production_sources WHERE source_id=NEW.resource_id) THEN RAISE EXCEPTION 'preparation source missing' USING ERRCODE='23514';END IF;
 END IF;
 IF TG_TABLE_NAME='digital_preparation_material_versions' THEN
  PERFORM pg_advisory_xact_lock(hashtextextended('preparation-material:'||NEW.resource_kind||':'||NEW.resource_id::text||':'||NEW.kind||':'||NEW.scope_ref,0));
  SELECT * INTO previous FROM digital_preparation_material_versions WHERE resource_kind=NEW.resource_kind AND resource_id=NEW.resource_id AND kind=NEW.kind AND scope_ref=NEW.scope_ref ORDER BY version DESC LIMIT 1;
  IF previous.record_id IS NULL THEN
   IF NEW.version<>1 THEN RAISE EXCEPTION 'preparation first version must be one' USING ERRCODE='23514';END IF;
  ELSIF NEW.record_id<>previous.record_id OR NEW.version<>previous.version+1 THEN
   RAISE EXCEPTION 'preparation correction must append current same-scope record' USING ERRCODE='23514';
  END IF;
 ELSIF TG_TABLE_NAME='digital_preparation_rule_adoptions' THEN
 IF NEW.creation_event_id IS NOT NULL THEN
  SELECT * INTO origin FROM audit_events WHERE id=NEW.creation_event_id;
  IF origin IS NULL OR origin.entity_id<>NEW.resource_id::text OR origin.actor_id<>NEW.adopted_by OR
   origin.action<>(CASE WHEN NEW.resource_kind='order' THEN 'digital_order_created' ELSE 'digital_source_created' END) THEN
   RAISE EXCEPTION 'preparation enrollment needs its original creation event' USING ERRCODE='23514';
  END IF;
 END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER preparation_material_identity BEFORE INSERT ON digital_preparation_material_versions FOR EACH ROW EXECUTE FUNCTION guard_preparation_evidence_identity();
CREATE TRIGGER preparation_adoption_identity BEFORE INSERT ON digital_preparation_rule_adoptions FOR EACH ROW EXECUTE FUNCTION guard_preparation_evidence_identity();
CREATE TRIGGER preparation_responsibility_identity BEFORE INSERT ON digital_preparation_responsibilities FOR EACH ROW EXECUTE FUNCTION guard_preparation_evidence_identity();
DO $$ DECLARE relation_name text;BEGIN
 FOREACH relation_name IN ARRAY ARRAY['digital_preparation_rule_adoptions','digital_preparation_adoption_acknowledgements','digital_preparation_responsibilities','digital_preparation_material_versions','digital_preparation_windows','digital_preparation_instruction_events','digital_instruction_preparation_bases','digital_instruction_deliveries','digital_bulk_work_ranges'] LOOP
  EXECUTE format('CREATE TRIGGER preparation_evidence_no_edit BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION guard_production_order_root_immutable()',relation_name);
  EXECUTE format('CREATE TRIGGER preparation_evidence_no_truncate BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION guard_production_order_root_immutable()',relation_name);
 END LOOP;
END $$;
