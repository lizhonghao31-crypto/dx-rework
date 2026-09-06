-- A disposed asset ends custody without fabricating a physical return.
ALTER TABLE sample_attachment_bindings ADD COLUMN active boolean NOT NULL DEFAULT true;
ALTER TABLE sample_custody_records ADD COLUMN disposed_at timestamptz;
ALTER TABLE sample_custody_records ADD CONSTRAINT sample_custody_close_kind CHECK(returned_at IS NULL OR disposed_at IS NULL);
ALTER TABLE sample_custody_records ADD CONSTRAINT sample_custody_disposed_time CHECK(disposed_at IS NULL OR disposed_at>=borrowed_at);
DROP INDEX sample_custody_one_open_idx;
CREATE UNIQUE INDEX sample_custody_one_open_idx ON sample_custody_records(sample_id) WHERE returned_at IS NULL AND disposed_at IS NULL;
CREATE OR REPLACE FUNCTION sample_guard_custody_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (to_jsonb(NEW)-'returned_at'-'disposed_at') IS DISTINCT FROM (to_jsonb(OLD)-'returned_at'-'disposed_at')
  OR OLD.returned_at IS NOT NULL OR OLD.disposed_at IS NOT NULL
  OR ((NEW.returned_at IS NULL)=(NEW.disposed_at IS NULL)) THEN
  RAISE EXCEPTION 'sample custody history is immutable except its first closure' USING ERRCODE='55000';
 END IF;
 RETURN NEW;
END; $$;

ALTER TABLE sample_disposals ADD COLUMN responsible_name text;
ALTER TABLE sample_disposals ADD COLUMN approved_by_name text;
ALTER TABLE sample_disposals ADD COLUMN paid_by_name text;
ALTER TABLE sample_disposals ADD COLUMN imported_batch_id uuid REFERENCES sample_migration_batches(batch_id);
UPDATE sample_disposals SET responsible_name=CASE WHEN responsible_user_id IS NOT NULL THEN '历史责任人（未留存当时姓名）' END,
 approved_by_name=CASE WHEN approved_by IS NOT NULL THEN '历史审批人（未留存当时姓名）' END,
 paid_by_name=CASE WHEN paid_by IS NOT NULL THEN '历史结案人（未留存当时姓名）' END;
CREATE FUNCTION sample_disposal_names() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.imported_batch_id IS NOT NULL THEN
   IF NEW.responsible_user_id IS NOT NULL THEN NEW.responsible_name=COALESCE(NEW.responsible_name,'历史责任人（未留存当时姓名）'); END IF;
   IF NEW.approved_by IS NOT NULL THEN NEW.approved_by_name=COALESCE(NEW.approved_by_name,'历史审批人（未留存当时姓名）'); END IF;
   IF NEW.paid_by IS NOT NULL THEN NEW.paid_by_name=COALESCE(NEW.paid_by_name,'历史结案人（未留存当时姓名）'); END IF;
  ELSE
   IF NEW.responsible_user_id IS NOT NULL THEN SELECT display_name INTO STRICT NEW.responsible_name FROM app_users WHERE id=NEW.responsible_user_id; END IF;
   IF NEW.approved_by IS NOT NULL THEN SELECT display_name INTO STRICT NEW.approved_by_name FROM app_users WHERE id=NEW.approved_by; END IF;
   IF NEW.paid_by IS NOT NULL THEN SELECT display_name INTO STRICT NEW.paid_by_name FROM app_users WHERE id=NEW.paid_by; END IF;
  END IF;
 ELSE
  IF NEW.imported_batch_id IS DISTINCT FROM OLD.imported_batch_id THEN RAISE EXCEPTION 'sample disposal provenance is immutable' USING ERRCODE='55000'; END IF;
  IF NEW.responsible_user_id IS DISTINCT FROM OLD.responsible_user_id OR NEW.responsible_name IS DISTINCT FROM OLD.responsible_name THEN
   RAISE EXCEPTION 'sample disposal responsibility is immutable' USING ERRCODE='55000';
  END IF;
  IF OLD.approved_by IS NULL AND NEW.approved_by IS NOT NULL THEN SELECT display_name INTO STRICT NEW.approved_by_name FROM app_users WHERE id=NEW.approved_by;
  ELSIF NEW.approved_by IS DISTINCT FROM OLD.approved_by OR NEW.approved_by_name IS DISTINCT FROM OLD.approved_by_name THEN RAISE EXCEPTION 'sample approval identity is immutable' USING ERRCODE='55000'; END IF;
  IF OLD.paid_by IS NULL AND NEW.paid_by IS NOT NULL THEN SELECT display_name INTO STRICT NEW.paid_by_name FROM app_users WHERE id=NEW.paid_by;
  ELSIF NEW.paid_by IS DISTINCT FROM OLD.paid_by OR NEW.paid_by_name IS DISTINCT FROM OLD.paid_by_name THEN RAISE EXCEPTION 'sample payment identity is immutable' USING ERRCODE='55000'; END IF;
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER sample_disposal_names BEFORE INSERT OR UPDATE ON sample_disposals FOR EACH ROW EXECUTE FUNCTION sample_disposal_names();

CREATE TABLE sample_archive_records (
 event_id uuid PRIMARY KEY REFERENCES operation_events(event_id),sample_id uuid NOT NULL REFERENCES sample_items(sample_id),
 item_snapshot jsonb NOT NULL,request_snapshot jsonb,created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX sample_archive_latest_idx ON sample_archive_records(sample_id,created_at DESC,event_id);
CREATE TABLE sample_import_keys (
 legacy_id text PRIMARY KEY,sample_id uuid NOT NULL UNIQUE REFERENCES sample_items(sample_id)
);
CREATE TABLE sample_import_versions (
 batch_id uuid NOT NULL REFERENCES sample_migration_batches(batch_id),legacy_id text NOT NULL REFERENCES sample_import_keys(legacy_id),
 sample_id uuid NOT NULL REFERENCES sample_items(sample_id),source_hash text NOT NULL CHECK(source_hash ~ '^[0-9a-f]{64}$'),
 item_version integer NOT NULL CHECK(item_version>0),operation_event_id uuid NOT NULL REFERENCES operation_events(event_id),
 created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,PRIMARY KEY(batch_id,legacy_id)
);
CREATE TABLE sample_migration_reconciliations (
 reconciliation_id uuid PRIMARY KEY,batch_id uuid NOT NULL REFERENCES sample_migration_batches(batch_id),
 plan_hash text NOT NULL CHECK(plan_hash ~ '^[0-9a-f]{64}$'),report jsonb NOT NULL,passed boolean NOT NULL,
 created_by uuid NOT NULL REFERENCES app_users(id),created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE sample_cutover_events (
 event_id uuid PRIMARY KEY REFERENCES operation_events(event_id),reconciliation_id uuid REFERENCES sample_migration_reconciliations(reconciliation_id),
 action text NOT NULL CHECK(action IN ('enable','disable')),evidence jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK(action<>'enable' OR reconciliation_id IS NOT NULL)
);
ALTER TABLE sample_custody_records ADD COLUMN imported_batch_id uuid REFERENCES sample_migration_batches(batch_id);
ALTER TABLE sample_custody_records ADD COLUMN legacy_id text;
ALTER TABLE sample_custody_records ALTER COLUMN requested_by DROP NOT NULL;
ALTER TABLE sample_custody_records ADD CONSTRAINT sample_custody_requester_provenance CHECK(requested_by IS NOT NULL OR (imported_batch_id IS NOT NULL AND legacy_id IS NOT NULL));
DO $$ DECLARE constraint_name text; BEGIN
 FOR constraint_name IN SELECT conname FROM pg_constraint WHERE conrelid='sample_custody_records'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%initial_custody%' LOOP
  EXECUTE format('ALTER TABLE sample_custody_records DROP CONSTRAINT %I',constraint_name);
 END LOOP;
END; $$;
ALTER TABLE sample_custody_records ADD CONSTRAINT sample_custody_confirmation_provenance CHECK(initial_custody OR confirmed_by IS NOT NULL OR (imported_batch_id IS NOT NULL AND legacy_id IS NOT NULL));
CREATE UNIQUE INDEX sample_imported_custody_identity ON sample_custody_records(sample_id,legacy_id) WHERE legacy_id IS NOT NULL;
ALTER TABLE sample_workflow_requests ADD COLUMN legacy_id text;
ALTER TABLE sample_workflow_requests ADD COLUMN imported_batch_id uuid REFERENCES sample_migration_batches(batch_id);
CREATE UNIQUE INDEX sample_imported_request_identity ON sample_workflow_requests(sample_id,legacy_id) WHERE legacy_id IS NOT NULL;
CREATE OR REPLACE FUNCTION sample_request_actor_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.imported_batch_id IS NOT NULL THEN NEW.requested_by_name=COALESCE(NEW.requested_by_name,'历史申请人（未留存当时姓名）');
  ELSE SELECT display_name INTO NEW.requested_by_name FROM app_users WHERE id=NEW.requested_by; END IF;
 ELSIF NEW.requested_by IS DISTINCT FROM OLD.requested_by OR NEW.requested_by_name IS DISTINCT FROM OLD.requested_by_name OR NEW.imported_batch_id IS DISTINCT FROM OLD.imported_batch_id THEN
  RAISE EXCEPTION 'sample request actor snapshot is immutable' USING ERRCODE='55000';
 END IF;
 RETURN NEW;
END; $$;
CREATE OR REPLACE FUNCTION sample_request_holder_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.imported_batch_id IS NOT NULL THEN
   IF NEW.requested_for IS NOT NULL THEN NEW.requested_for_name=COALESCE(NEW.requested_for_name,'历史持有人（未留存当时姓名）'); END IF;
  ELSE
   IF NEW.requested_for IS NOT NULL THEN SELECT display_name INTO STRICT NEW.requested_for_name FROM app_users WHERE id=NEW.requested_for; END IF;
   SELECT department INTO STRICT NEW.department FROM sample_items WHERE sample_id=NEW.sample_id;
  END IF;
 ELSIF NEW.requested_for IS DISTINCT FROM OLD.requested_for OR NEW.requested_for_name IS DISTINCT FROM OLD.requested_for_name OR NEW.department IS DISTINCT FROM OLD.department THEN
  RAISE EXCEPTION 'sample request holder snapshots are immutable' USING ERRCODE='55000';
 END IF;
 RETURN NEW;
END; $$;
CREATE TABLE sample_migration_objects (
 batch_id uuid NOT NULL REFERENCES sample_migration_batches(batch_id),object_key text NOT NULL,
 attachment_id uuid NOT NULL REFERENCES attachments(attachment_id),sha256 char(64) NOT NULL,
 size_bytes bigint NOT NULL CHECK(size_bytes>0),PRIMARY KEY(batch_id,object_key)
);
CREATE TABLE sample_migration_plans (
 batch_id uuid PRIMARY KEY REFERENCES sample_migration_batches(batch_id),plan_hash char(64) NOT NULL,
 plan jsonb NOT NULL,created_by uuid NOT NULL REFERENCES app_users(id),created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
DO $$ DECLARE table_name text; BEGIN
 FOREACH table_name IN ARRAY ARRAY['sample_archive_records','sample_import_keys','sample_import_versions','sample_migration_reconciliations','sample_cutover_events','sample_migration_objects','sample_migration_plans'] LOOP
  EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation()',table_name||'_immutable',table_name);
  EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION reject_operation_event_mutation()',table_name||'_no_truncate',table_name);
 END LOOP;
END; $$;
