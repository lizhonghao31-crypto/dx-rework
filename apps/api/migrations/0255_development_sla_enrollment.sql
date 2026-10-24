-- New-source enrollment is explicit. Existing published routes are not rewritten.
CREATE TABLE digital_development_sla_plans (
 source_id uuid NOT NULL REFERENCES digital_production_sources(source_id),
 revision integer NOT NULL CHECK(revision > 0),
 configuration_id uuid NOT NULL REFERENCES digital_sla_configurations(configuration_id),
 rule_version text NOT NULL CHECK(rule_version='20261023.1'),
 parameters_json jsonb NOT NULL CHECK(jsonb_typeof(parameters_json)='object'),
 plan_json jsonb NOT NULL CHECK(jsonb_typeof(plan_json)='object'),
 route_nodes text[] NOT NULL,
 created_by uuid NOT NULL REFERENCES app_users(id),
 recorded_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 business_time jsonb NOT NULL CHECK(jsonb_typeof(business_time)='object'),
 reason text NOT NULL CHECK(length(btrim(reason))>0),
 event_key text NOT NULL UNIQUE,
 PRIMARY KEY(source_id,revision)
);
CREATE TRIGGER digital_development_sla_plan_history BEFORE UPDATE OR DELETE ON digital_development_sla_plans
FOR EACH ROW EXECUTE FUNCTION guard_production_order_root_immutable();

-- Optional metadata on new reminders; old information notices and receipt history remain intact.
ALTER TABLE digital_development_notices ADD COLUMN material_id uuid;
ALTER TABLE digital_production_deadline_revisions ADD COLUMN sla_basis jsonb CHECK(sla_basis IS NULL OR jsonb_typeof(sla_basis)='object');

INSERT INTO digital_production_deadline_policies(node_key,version,label,sla_seconds,warning_ratio)
VALUES ('development_pre_wash_check',1,'洗前尺寸检查',1800,0.7);

ALTER TABLE digital_development_route_facts DROP CONSTRAINT digital_development_route_facts_kind_check,
 ADD CONSTRAINT digital_development_route_facts_kind_check CHECK(kind IN ('发工艺','工艺完成','工艺确认','转交车板','车板完成','洗前检查','洗水送出','洗水完成','尾查通过','尾查退回','最终设计确认','寄出','客户样板确认'));
ALTER TABLE digital_development_upload_purposes
 DROP CONSTRAINT digital_development_upload_purposes_purpose_check,
 DROP CONSTRAINT digital_development_upload_task_check,
 ADD CONSTRAINT digital_development_upload_purposes_purpose_check CHECK(purpose IN ('工艺开发板','面料报告','车板成果','纸样成果','尾查照片','外部纸样')),
 ADD CONSTRAINT digital_development_upload_task_check CHECK((purpose IN ('车板成果','纸样成果','尾查照片'))=(task_id IS NOT NULL));

CREATE TABLE digital_development_fixed_cutting (
 version integer PRIMARY KEY CHECK(version>0),
 worker_id uuid NOT NULL REFERENCES app_users(id),
 changed_by uuid NOT NULL REFERENCES app_users(id),
 recorded_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 reason text NOT NULL CHECK(length(btrim(reason))>0)
);
CREATE TRIGGER digital_development_fixed_cutting_history BEFORE UPDATE OR DELETE ON digital_development_fixed_cutting
FOR EACH ROW EXECUTE FUNCTION guard_production_order_root_immutable();

-- External pattern requests are factual records, not approvals or development gates.
CREATE TABLE digital_development_external_patterns (
 request_id uuid PRIMARY KEY,
 source_id uuid NOT NULL REFERENCES digital_production_sources(source_id),
 round_number integer NOT NULL CHECK(round_number>0),
 requested_at timestamptz NOT NULL,
 requested_by uuid NOT NULL REFERENCES app_users(id),
 note text NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(source_id,round_number)
);
CREATE TABLE digital_development_external_pattern_receipts (
 request_id uuid PRIMARY KEY REFERENCES digital_development_external_patterns(request_id),
 received_at timestamptz NOT NULL,
 received_by uuid NOT NULL REFERENCES app_users(id),
 attachment_ids uuid[] NOT NULL CHECK(cardinality(attachment_ids)>0),
 note text NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TRIGGER digital_external_pattern_request_history BEFORE UPDATE OR DELETE ON digital_development_external_patterns
FOR EACH ROW EXECUTE FUNCTION guard_production_order_root_immutable();
CREATE TRIGGER digital_external_pattern_receipt_history BEFORE UPDATE OR DELETE ON digital_development_external_pattern_receipts
FOR EACH ROW EXECUTE FUNCTION guard_production_order_root_immutable();
INSERT INTO digital_production_deadline_policies(node_key,version,label,sla_seconds,warning_ratio)
VALUES ('development_external_pattern',1,'外部纸样跟进',172800,0.7);

-- Customer revisions are independent development sources, never extra customer-order quantities.
CREATE TABLE digital_development_revision_sources (
 source_id uuid PRIMARY KEY REFERENCES digital_production_sources(source_id),
 parent_source_id uuid NOT NULL REFERENCES digital_production_sources(source_id),
 root_source_id uuid NOT NULL REFERENCES digital_production_sources(source_id),
 revision_number integer NOT NULL CHECK(revision_number>0),
 parent_round integer NOT NULL CHECK(parent_round>0),
 origin text NOT NULL CHECK(origin IN ('客户新增要求','未达原要求')),
 customer_comment text NOT NULL CHECK(length(btrim(customer_comment))>0),
 explanation text NOT NULL, categories text[] NOT NULL, affected_nodes text[] NOT NULL,
 output_kind text NOT NULL CHECK(output_kind IN ('整件样板','工艺布片')),
 created_by uuid NOT NULL REFERENCES app_users(id), recorded_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK(source_id<>parent_source_id AND source_id<>root_source_id), UNIQUE(root_source_id,revision_number)
);
CREATE TABLE digital_development_inherited_files (
 source_id uuid NOT NULL REFERENCES digital_development_revision_sources(source_id),
 attachment_id uuid NOT NULL REFERENCES attachments(attachment_id),
 original_source_id uuid NOT NULL REFERENCES digital_production_sources(source_id),
 inherited_by uuid NOT NULL REFERENCES app_users(id), recorded_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(source_id,attachment_id)
);
CREATE TRIGGER digital_development_revision_source_history BEFORE UPDATE OR DELETE ON digital_development_revision_sources
FOR EACH ROW EXECUTE FUNCTION guard_production_order_root_immutable();
CREATE TRIGGER digital_development_inherited_file_history BEFORE UPDATE OR DELETE ON digital_development_inherited_files
FOR EACH ROW EXECUTE FUNCTION guard_production_order_root_immutable();
