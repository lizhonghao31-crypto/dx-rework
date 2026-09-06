-- SAMPLE-MIGRATION-SPEC-V1.0 / PR-1. Additive only; no production import or UI activation.
DROP TRIGGER capability_catalog_no_insert ON capability_catalog;
DROP TRIGGER business_roles_no_insert ON business_roles;
DROP TRIGGER role_capabilities_no_insert ON role_capabilities;
INSERT INTO capability_catalog(capability,display_name,description) VALUES
 ('sample:view_basic','样衣基本资料','查看样衣非财务资料'),
 ('sample:view_finance','样衣财务资料','查看采购价、小票和金额汇总'),
 ('sample:view_audit','样衣操作记录','查看按字段权限裁剪的样衣历史'),
 ('sample:create','新增样衣','建档并首次直接领用'),
 ('sample:batch_create','批量新增样衣','批量建档'),
 ('sample:borrow_request','申请借出样衣','在库样衣借用申请'),
 ('sample:borrow_confirm','确认交付样衣','行政扫码确认借出'),
 ('sample:return_request','申请归还样衣','本人持有样衣归还申请'),
 ('sample:return_confirm','确认收到样衣','行政扫码收货和记录位置'),
 ('sample:update_basic','维护样衣资料','维护非财务主档'),
 ('sample:update_location','维护样衣位置','维护在库位置'),
 ('sample:correct_finance','更正样衣财务资料','仅 root 可更正并说明原因'),
 ('sample:dispose_request','申请处置样衣','出售、赠送、报废和遗失申请'),
 ('sample:dispose_approve','审批样衣处置','仅老板或 root 审批'),
 ('sample:loss_close','确认样衣赔付','行政上传付款证明后结案'),
 ('sample:archive','归档及恢复样衣','仅 root 逻辑归档及恢复');

INSERT INTO business_roles(role_code,display_name,description) VALUES
 ('sample_designer','样衣设计师','样衣使用人；无财务可见权限'),
 ('sample_administrative','样衣行政','实物交接和处置执行；不是系统管理员'),
 ('sample_finance','样衣财务','建档与财务查询；提交后不得修改财务数据');
INSERT INTO role_capabilities(role_code,capability)
SELECT role_code,'tools:user' FROM business_roles
WHERE role_code IN ('sample_designer','sample_administrative','sample_finance');
INSERT INTO role_capabilities(role_code,capability) VALUES
 ('sample_designer','sample:view_basic'),('sample_designer','sample:borrow_request'),('sample_designer','sample:return_request'),
 ('sample_administrative','sample:view_basic'),('sample_administrative','sample:view_audit'),
 ('sample_administrative','sample:borrow_confirm'),('sample_administrative','sample:return_confirm'),
 ('sample_administrative','sample:update_basic'),('sample_administrative','sample:update_location'),
 ('sample_administrative','sample:dispose_request'),('sample_administrative','sample:loss_close'),
 ('sample_finance','sample:view_basic'),('sample_finance','sample:view_finance'),('sample_finance','sample:view_audit'),
 ('sample_finance','sample:create'),('sample_finance','sample:batch_create'),
 ('owner_group','sample:view_basic'),('owner_group','sample:view_finance'),('owner_group','sample:view_audit'),
 ('owner_group','sample:borrow_request'),('owner_group','sample:return_request'),
 ('owner_group','sample:dispose_request'),('owner_group','sample:dispose_approve');
-- Deliberately no sample grants for system_admin, and no human role gets root-only grants.
CREATE TRIGGER capability_catalog_no_insert BEFORE INSERT ON capability_catalog
 FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER business_roles_no_insert BEFORE INSERT ON business_roles
 FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER role_capabilities_no_insert BEFORE INSERT ON role_capabilities
 FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();

CREATE TABLE sample_items (
 sample_id uuid PRIMARY KEY,
 sample_code text NOT NULL UNIQUE CHECK (length(btrim(sample_code)) BETWEEN 1 AND 100),
 status text NOT NULL CHECK (status IN ('borrowed','return_pending','in_stock','borrow_pending','disposal_pending',
   'loss_payment_pending','sold','gifted','scrapped','lost','archived')),
 version integer NOT NULL DEFAULT 1 CHECK (version>0),
 brand text NOT NULL CHECK (length(btrim(brand))>0),
 style_name text NOT NULL CHECK (length(btrim(style_name))>0),
 style_no text NOT NULL DEFAULT '', category text NOT NULL DEFAULT '',
 color text NOT NULL CHECK (length(btrim(color))>0), size text NOT NULL DEFAULT '',
 department text NOT NULL CHECK (length(btrim(department))>0), purchase_date date NOT NULL,
 purchaser_user_id uuid NOT NULL REFERENCES app_users(id), purchaser_name text NOT NULL,
 holder_user_id uuid REFERENCES app_users(id), holder_name text,
 purpose text, borrowed_at timestamptz, storage_location text, remark text NOT NULL DEFAULT '',
 external_source text, external_id text, erp_node_id text,
 created_by uuid NOT NULL REFERENCES app_users(id),
 created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 archived_from_status text, archived_reason text,
 CHECK ((holder_user_id IS NULL)=(holder_name IS NULL)),
 CHECK (status NOT IN ('in_stock','borrow_pending') OR
   (holder_user_id IS NULL AND storage_location IS NOT NULL AND length(btrim(storage_location))>0)),
 CHECK (status NOT IN ('borrowed','return_pending','loss_payment_pending') OR
   (holder_user_id IS NOT NULL AND storage_location IS NULL AND borrowed_at IS NOT NULL)),
 CHECK ((external_source IS NULL)=(external_id IS NULL)),
 CHECK ((status='archived' AND archived_from_status IS NOT NULL AND archived_reason IS NOT NULL AND length(btrim(archived_reason))>0)
   OR (status<>'archived' AND archived_from_status IS NULL AND archived_reason IS NULL)),
 CHECK (archived_from_status IS NULL OR archived_from_status IN ('borrowed','return_pending','in_stock',
   'borrow_pending','disposal_pending','loss_payment_pending','sold','gifted','scrapped','lost')),
 UNIQUE(external_source,external_id)
);
CREATE INDEX sample_items_status_page_idx ON sample_items(status,created_at DESC,sample_id);
CREATE INDEX sample_items_holder_idx ON sample_items(holder_user_id,status,created_at DESC);
CREATE INDEX sample_items_brand_idx ON sample_items(brand,status);
CREATE INDEX sample_items_purchase_date_idx ON sample_items(purchase_date,status);
CREATE INDEX sample_items_department_idx ON sample_items(department,status);

-- Finance separated from the default basic-data projection.
CREATE TABLE sample_financial_facts (
 sample_id uuid PRIMARY KEY REFERENCES sample_items(sample_id),
 purchase_price numeric(14,2) NOT NULL CHECK (purchase_price>=0),
 version integer NOT NULL DEFAULT 1 CHECK (version>0)
);
CREATE TABLE sample_attachment_bindings (
 sample_id uuid NOT NULL REFERENCES sample_items(sample_id),
 attachment_id uuid NOT NULL REFERENCES attachments(attachment_id),
 purpose text NOT NULL CHECK (purpose IN ('sample_image','purchase_receipt','return_photo','disposal_proof','payment_proof')),
 bound_by uuid NOT NULL REFERENCES app_users(id), bound_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(sample_id,attachment_id,purpose)
);
CREATE INDEX sample_attachment_lookup_idx ON sample_attachment_bindings(attachment_id);

CREATE TABLE sample_custody_records (
 custody_id uuid PRIMARY KEY, sample_id uuid NOT NULL REFERENCES sample_items(sample_id),
 holder_user_id uuid NOT NULL REFERENCES app_users(id), holder_name text NOT NULL,
 department text NOT NULL, purpose text NOT NULL CHECK (length(btrim(purpose))>0),
 borrowed_at timestamptz NOT NULL, returned_at timestamptz,
 requested_by uuid NOT NULL REFERENCES app_users(id), confirmed_by uuid REFERENCES app_users(id),
 initial_custody boolean NOT NULL DEFAULT false,
 CHECK (returned_at IS NULL OR returned_at>=borrowed_at),
 CHECK (initial_custody OR confirmed_by IS NOT NULL)
);
CREATE UNIQUE INDEX sample_custody_one_open_idx ON sample_custody_records(sample_id) WHERE returned_at IS NULL;
CREATE INDEX sample_custody_history_idx ON sample_custody_records(sample_id,borrowed_at DESC);

CREATE TABLE sample_workflow_requests (
 request_id uuid PRIMARY KEY, sample_id uuid NOT NULL REFERENCES sample_items(sample_id),
 request_type text NOT NULL CHECK (request_type IN ('borrow','return','sale','gift','scrap','loss')),
 status text NOT NULL CHECK (status IN ('pending','payment_pending','completed','rejected','cancelled')),
 from_status text NOT NULL CHECK (from_status IN ('borrowed','in_stock')),
 requested_by uuid NOT NULL REFERENCES app_users(id), requested_for uuid REFERENCES app_users(id),
 purpose text, reason text NOT NULL DEFAULT '', version integer NOT NULL DEFAULT 1 CHECK (version>0),
 resolved_by uuid REFERENCES app_users(id), resolution_reason text, resolved_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK ((status IN ('completed','rejected','cancelled'))=(resolved_at IS NOT NULL AND resolved_by IS NOT NULL))
);
CREATE UNIQUE INDEX sample_request_one_active_idx ON sample_workflow_requests(sample_id)
 WHERE status IN ('pending','payment_pending');
CREATE INDEX sample_request_pending_idx ON sample_workflow_requests(status,request_type,created_at);

CREATE TABLE sample_disposals (
 disposal_id uuid PRIMARY KEY, request_id uuid NOT NULL UNIQUE REFERENCES sample_workflow_requests(request_id),
 sample_id uuid NOT NULL REFERENCES sample_items(sample_id),
 disposal_type text NOT NULL CHECK (disposal_type IN ('sale','gift','scrap','loss')),
 recipient text, responsible_user_id uuid REFERENCES app_users(id),
 proposed_amount numeric(14,2) CHECK (proposed_amount>=0),
 final_amount numeric(14,2) CHECK (final_amount>=0),
 approved_by uuid REFERENCES app_users(id), approved_at timestamptz,
 paid_by uuid REFERENCES app_users(id), paid_at timestamptz,
 CHECK ((approved_by IS NULL)=(approved_at IS NULL)),
 CHECK ((paid_by IS NULL)=(paid_at IS NULL)),
 CHECK (paid_at IS NULL OR approved_at IS NOT NULL),
 CHECK (disposal_type<>'loss' OR responsible_user_id IS NOT NULL),
 CHECK (disposal_type<>'loss' OR approved_at IS NULL OR (final_amount IS NOT NULL AND final_amount>0))
);
CREATE INDEX sample_disposal_date_idx ON sample_disposals(disposal_type,approved_at,sample_id);

CREATE TABLE sample_migration_batches (
 batch_id uuid PRIMARY KEY,
 source_system text NOT NULL CHECK (source_system='daxing-sample-assistant'),
 source_hash text NOT NULL CHECK (source_hash ~ '^[0-9a-f]{64}$'),
 source_updated_at text NOT NULL,
 sample_count integer NOT NULL CHECK (sample_count>=0), log_count integer NOT NULL CHECK (log_count>=0),
 report jsonb NOT NULL,
 created_by uuid NOT NULL REFERENCES app_users(id), created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(source_system,source_hash)
);
CREATE TABLE sample_legacy_mappings (
 batch_id uuid NOT NULL REFERENCES sample_migration_batches(batch_id),
 entity_type text NOT NULL CHECK (entity_type IN ('sample','log','borrow_request')),
 legacy_id text NOT NULL, source_hash text NOT NULL CHECK (source_hash ~ '^[0-9a-f]{64}$'),
 source_payload jsonb NOT NULL,
 PRIMARY KEY(batch_id,entity_type,legacy_id)
);
CREATE TABLE sample_migration_imports (
 batch_id uuid NOT NULL REFERENCES sample_migration_batches(batch_id),
 legacy_id text NOT NULL, sample_id uuid NOT NULL UNIQUE REFERENCES sample_items(sample_id),
 imported_by uuid NOT NULL REFERENCES app_users(id), imported_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(batch_id,legacy_id)
);

-- Retain original histories. Corrections append new audit events; never rewrite the source.
CREATE TRIGGER sample_migration_batches_immutable BEFORE UPDATE OR DELETE ON sample_migration_batches
 FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER sample_legacy_mappings_immutable BEFORE UPDATE OR DELETE ON sample_legacy_mappings
 FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER sample_migration_imports_immutable BEFORE UPDATE OR DELETE ON sample_migration_imports
 FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER sample_items_no_delete BEFORE DELETE ON sample_items
 FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER sample_custody_no_delete BEFORE DELETE ON sample_custody_records
 FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE FUNCTION sample_guard_custody_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (to_jsonb(NEW)-'returned_at') IS DISTINCT FROM (to_jsonb(OLD)-'returned_at')
   OR OLD.returned_at IS NOT NULL OR NEW.returned_at IS NULL THEN
   RAISE EXCEPTION 'sample custody history is immutable except its first return confirmation' USING ERRCODE='55000';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER sample_custody_guard_update BEFORE UPDATE ON sample_custody_records
 FOR EACH ROW EXECUTE FUNCTION sample_guard_custody_update();
CREATE TRIGGER sample_batches_no_truncate BEFORE TRUNCATE ON sample_migration_batches
 FOR EACH STATEMENT EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER sample_mappings_no_truncate BEFORE TRUNCATE ON sample_legacy_mappings
 FOR EACH STATEMENT EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER sample_imports_no_truncate BEFORE TRUNCATE ON sample_migration_imports
 FOR EACH STATEMENT EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER sample_items_no_truncate BEFORE TRUNCATE ON sample_items
 FOR EACH STATEMENT EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER sample_custody_no_truncate BEFORE TRUNCATE ON sample_custody_records
 FOR EACH STATEMENT EXECUTE FUNCTION reject_operation_event_mutation();
