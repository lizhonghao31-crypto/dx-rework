INSERT INTO digital_production_deadline_policies(node_key,version,label,sla_seconds,warning_ratio)
 VALUES('development_material_supply',1,'开发缺料补齐',NULL,0.8),('development_material_recheck',1,'开发缺项复核',NULL,0.8);
CREATE TABLE digital_development_dispatch (
 source_id uuid PRIMARY KEY REFERENCES digital_production_sources(source_id),
 version integer NOT NULL DEFAULT 1 CHECK(version>0),
 pattern_worker_id uuid NOT NULL REFERENCES app_users(id),
 cutting_worker_id uuid NOT NULL REFERENCES app_users(id),
 sewing_worker_id uuid NOT NULL REFERENCES app_users(id),
 changed_by uuid NOT NULL REFERENCES app_users(id),
 changed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE digital_development_execution_facts (
 fact_id uuid PRIMARY KEY,
 source_id uuid NOT NULL REFERENCES digital_production_sources(source_id),
 task_id uuid REFERENCES digital_production_tasks(task_id),
 kind text NOT NULL CHECK(kind IN ('核配通过','缺项退回','补料复核','纸样完成','裁板完成','面料报告','面料决定')),
 payload jsonb NOT NULL,
 actor_id uuid NOT NULL REFERENCES app_users(id),
 recorded_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 sequence bigint GENERATED ALWAYS AS IDENTITY
);
CREATE INDEX digital_development_execution_history ON digital_development_execution_facts(source_id,sequence);
CREATE UNIQUE INDEX digital_development_one_work_fact ON digital_development_execution_facts(task_id,kind) WHERE kind IN ('核配通过','缺项退回','纸样完成','裁板完成');
CREATE TRIGGER digital_development_execution_history_immutable BEFORE UPDATE OR DELETE ON digital_development_execution_facts
 FOR EACH ROW EXECUTE FUNCTION guard_production_order_root_immutable();

CREATE TABLE digital_development_upload_purposes (
 attachment_id uuid PRIMARY KEY REFERENCES attachments(attachment_id),
 source_id uuid NOT NULL REFERENCES digital_production_sources(source_id),
 purpose text NOT NULL CHECK(purpose IN ('工艺开发板','面料报告')),
 uploaded_by uuid NOT NULL REFERENCES app_users(id),
 created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TRIGGER digital_development_upload_purpose_immutable BEFORE UPDATE OR DELETE ON digital_development_upload_purposes
 FOR EACH ROW EXECUTE FUNCTION guard_production_order_root_immutable();
