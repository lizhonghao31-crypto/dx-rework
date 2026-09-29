-- All new history is append-only. 0217 and legacy calendars remain unchanged.
CREATE TABLE digital_production_deadline_policies (
 node_key text NOT NULL, version integer NOT NULL CHECK(version>0), label text NOT NULL,
 sla_seconds numeric CHECK(sla_seconds>0), warning_ratio numeric NOT NULL CHECK(warning_ratio>0 AND warning_ratio<1),
 changed_by uuid REFERENCES app_users(id), changed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 note text NOT NULL DEFAULT '', PRIMARY KEY(node_key,version)
);
INSERT INTO digital_production_deadline_policies(node_key,version,label,sla_seconds,warning_ratio) VALUES
 ('development_materials',1,'开发核配委派',14400,0.8),('development_pattern',1,'开发纸样',172800,0.8),
 ('development_cutting',1,'开发裁板',14400,0.8),('development_printing',1,'开发印花',345600,0.8),
 ('development_embroidery',1,'开发绣花',345600,0.8),('development_print_embroidery',1,'开发印绣花',604800,0.8),
 ('development_washing',1,'开发洗水',86400,0.8),('development_sewing',1,'开发车板',86400,0.8),
 ('development_tail_check',1,'板房尾查',14400,0.8),('bulk_pattern',1,'大货纸样唛架',172800,0.8),
 ('warehouse_preshrink',1,'整批预缩',129600,0.8),('bulk_cutting',1,'本厂整款开裁',86400,0.8),
 ('factory_material_count',1,'到厂面辅料清点',172800,0.8),('process_logistics',1,'工艺中转',NULL,0.8),
 ('development_shipping',1,'开发寄样',NULL,0.8),('development_confirmation',1,'设计确认',NULL,0.8),
 ('budget',1,'预算编制',NULL,0.8),('production_sheet',1,'制单编制',NULL,0.8),
 ('bulk_qc',1,'大货质检',NULL,0.8),('warehouse_dispatch',1,'仓库发出',NULL,0.8);
CREATE TABLE digital_production_resource_lifecycle (
 resource_kind text NOT NULL CHECK(resource_kind IN ('order','source')), resource_id uuid NOT NULL,
 order_id uuid GENERATED ALWAYS AS (CASE WHEN resource_kind='order' THEN resource_id END) STORED REFERENCES digital_production_orders(production_order_id),
 source_id uuid GENERATED ALWAYS AS (CASE WHEN resource_kind='source' THEN resource_id END) STORED REFERENCES digital_production_sources(source_id),
 state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','paused','cancelled')),
 changed_by uuid NOT NULL REFERENCES app_users(id),changed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 reason text, PRIMARY KEY(resource_kind,resource_id)
);
ALTER TABLE digital_production_task_access ADD UNIQUE(task_id,task_kind);
CREATE TABLE digital_production_tasks (
 task_id uuid PRIMARY KEY REFERENCES digital_production_task_access(task_id),
 node_key text NOT NULL, FOREIGN KEY(task_id,node_key) REFERENCES digital_production_task_access(task_id,task_kind),
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','ready','blocked','completed','cancelled')),
 route_version integer NOT NULL CHECK(route_version>0), occurrence integer NOT NULL CHECK(occurrence>0),
 route_instance_id uuid NOT NULL,
 entered_at timestamptz, entered_quality text NOT NULL DEFAULT '缺失' CHECK(entered_quality IN ('现场登记','补报未核实','已核实','缺失')),
 completed_at timestamptz, completed_quality text NOT NULL DEFAULT '缺失' CHECK(completed_quality IN ('现场登记','补报未核实','已核实','缺失')), terminal_recorded_at timestamptz,
 blocked_reason text, baseline_clock_id uuid REFERENCES production_order_node_clocks(node_instance_id),
 created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK(completed_at IS NULL OR entered_at IS NULL OR completed_at>=entered_at)
);
CREATE UNIQUE INDEX digital_task_route_occurrence ON digital_production_tasks(route_instance_id,node_key,occurrence);
CREATE TABLE digital_production_task_dependencies (
 task_id uuid NOT NULL REFERENCES digital_production_tasks(task_id),
 predecessor_id uuid NOT NULL REFERENCES digital_production_tasks(task_id),
 PRIMARY KEY(task_id,predecessor_id), CHECK(task_id<>predecessor_id)
);
CREATE TABLE digital_production_task_conditions (
 task_id uuid NOT NULL REFERENCES digital_production_tasks(task_id),
 condition_key text NOT NULL, stage text NOT NULL DEFAULT 'activation' CHECK(stage IN ('activation','completion')), satisfied boolean NOT NULL DEFAULT false, occurred_at timestamptz,
 PRIMARY KEY(task_id,condition_key)
);
CREATE TABLE digital_production_task_events (
 event_id uuid PRIMARY KEY, task_id uuid REFERENCES digital_production_tasks(task_id),
 resource_kind text CHECK(resource_kind IN ('order','source')), resource_id uuid,
 event_kind text NOT NULL, actor_id uuid NOT NULL REFERENCES app_users(id),
 occurred_at timestamptz, recorded_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 time_quality text NOT NULL CHECK(time_quality IN ('现场登记','补报未核实','已核实','缺失')),
 corrects_event_id uuid REFERENCES digital_production_task_events(event_id), payload jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX digital_task_events_task_idx ON digital_production_task_events(task_id,recorded_at,event_id);
CREATE TABLE digital_production_deadline_revisions (
 revision_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 task_id uuid NOT NULL REFERENCES digital_production_tasks(task_id),
 policy_node_key text NOT NULL, policy_version integer NOT NULL,
 entered_at timestamptz, warning_at timestamptz, due_at timestamptz,
 reason text NOT NULL CHECK(reason IN ('activation','policy','correction','completion')),
 event_id uuid REFERENCES digital_production_task_events(event_id),
 changed_by uuid NOT NULL REFERENCES app_users(id),changed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(policy_node_key,policy_version) REFERENCES digital_production_deadline_policies(node_key,version),
 CHECK((warning_at IS NULL)=(due_at IS NULL)),
 CHECK(due_at IS NULL OR (entered_at IS NOT NULL AND warning_at>=entered_at AND due_at>=warning_at))
);
CREATE INDEX digital_task_current_deadline_idx ON digital_production_deadline_revisions(task_id,revision_id DESC);
CREATE TABLE digital_production_event_intents (
 event_id uuid PRIMARY KEY REFERENCES digital_production_task_events(event_id),
 task_id uuid REFERENCES digital_production_tasks(task_id),
 event_kind text NOT NULL, created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 notification_policy text NOT NULL DEFAULT 'IN_APP_ONLY' CHECK(notification_policy='IN_APP_ONLY')
);
CREATE TRIGGER digital_deadline_policy_history BEFORE UPDATE OR DELETE ON digital_production_deadline_policies FOR EACH ROW EXECUTE FUNCTION guard_production_order_root_immutable();
CREATE TRIGGER digital_task_event_history BEFORE UPDATE OR DELETE ON digital_production_task_events FOR EACH ROW EXECUTE FUNCTION guard_production_order_root_immutable();
CREATE TRIGGER digital_deadline_revision_history BEFORE UPDATE OR DELETE ON digital_production_deadline_revisions FOR EACH ROW EXECUTE FUNCTION guard_production_order_root_immutable();
CREATE TRIGGER digital_event_intent_history BEFORE UPDATE OR DELETE ON digital_production_event_intents FOR EACH ROW EXECUTE FUNCTION guard_production_order_root_immutable();
