-- Development sources keep immutable published forms; material facts append separately.
CREATE TABLE digital_development_documents (
 source_id uuid PRIMARY KEY REFERENCES digital_production_sources(source_id),
 version integer NOT NULL CHECK(version>0),
 status text NOT NULL CHECK(status IN ('draft','published')),
 document jsonb NOT NULL CHECK(jsonb_typeof(document)='object'),
 published_at timestamptz,
 task_id uuid REFERENCES digital_production_tasks(task_id),
 updated_by uuid NOT NULL REFERENCES app_users(id),
 updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK((status='published')=(published_at IS NOT NULL)),
 CHECK((status='published')=(task_id IS NOT NULL))
);
CREATE FUNCTION guard_digital_development_publication() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.status='published' THEN RAISE EXCEPTION 'Published development document is immutable'; END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER digital_development_publication_immutable BEFORE UPDATE OR DELETE ON digital_development_documents
 FOR EACH ROW EXECUTE FUNCTION guard_digital_development_publication();
CREATE TABLE digital_development_material_events (
 event_id uuid PRIMARY KEY,
 source_id uuid NOT NULL REFERENCES digital_development_documents(source_id),
 material_id uuid NOT NULL,
 action text NOT NULL CHECK(action IN ('到货','修改预计日期','确认代用')),
 expected_date date,
 note text NOT NULL,
 actor_id uuid NOT NULL REFERENCES app_users(id),
 created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK(action<>'修改预计日期' OR expected_date IS NOT NULL),
 CHECK(action<>'确认代用' OR length(btrim(note))>0)
);
CREATE INDEX digital_development_material_history ON digital_development_material_events(source_id,created_at,event_id);
CREATE TRIGGER digital_development_material_history_immutable BEFORE UPDATE OR DELETE ON digital_development_material_events
 FOR EACH ROW EXECUTE FUNCTION guard_production_order_root_immutable();
CREATE TABLE digital_development_attachment_bindings (
 attachment_id uuid PRIMARY KEY REFERENCES attachments(attachment_id),
 source_id uuid NOT NULL REFERENCES digital_production_sources(source_id),
 bound_by uuid NOT NULL REFERENCES app_users(id),
 created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TRIGGER digital_development_attachment_history BEFORE UPDATE OR DELETE ON digital_development_attachment_bindings
 FOR EACH ROW EXECUTE FUNCTION guard_production_order_root_immutable();
ALTER TABLE digital_development_material_events ADD COLUMN sequence bigint GENERATED ALWAYS AS IDENTITY;
ALTER TABLE digital_production_notification_events ADD COLUMN development_source_id uuid REFERENCES digital_production_sources(source_id);
ALTER TABLE digital_production_notification_events DROP CONSTRAINT digital_production_notification_events_check;
ALTER TABLE digital_production_notification_events ADD CONSTRAINT digital_notification_one_target CHECK(num_nonnulls(task_id,todo_id,development_source_id)=1);
CREATE TABLE digital_development_notices (
 event_id uuid PRIMARY KEY REFERENCES digital_production_notification_events(event_id),
 source_id uuid NOT NULL REFERENCES digital_production_sources(source_id),
 title text NOT NULL
);
