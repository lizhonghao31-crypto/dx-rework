INSERT INTO digital_production_deadline_policies(node_key,version,label,sla_seconds,warning_ratio)
VALUES ('development_washing_dispatch',1,'文员送洗登记',NULL,0.8),
       ('development_craft_dispatch',1,'设计师发工艺',NULL,0.8),
       ('development_craft_confirmation',1,'设计师工艺确认',NULL,0.8),
       ('development_sewing_transfer',1,'文员转交车板',NULL,0.8);

CREATE TABLE digital_development_route_facts (
 fact_id uuid PRIMARY KEY,
 source_id uuid NOT NULL REFERENCES digital_production_sources(source_id),
 task_id uuid REFERENCES digital_production_tasks(task_id),
 route_version integer NOT NULL CHECK(route_version>0),
 kind text NOT NULL CHECK(kind IN ('发工艺','工艺完成','工艺确认','转交车板','车板完成','洗水送出','洗水完成','尾查通过','尾查退回','最终设计确认','寄出','客户样板确认')),
 payload jsonb NOT NULL,
 actor_id uuid NOT NULL REFERENCES app_users(id),
 recorded_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 sequence bigint GENERATED ALWAYS AS IDENTITY
);
CREATE UNIQUE INDEX digital_development_route_task_fact ON digital_development_route_facts(task_id,kind) WHERE task_id IS NOT NULL;
CREATE UNIQUE INDEX digital_development_customer_sample_fact ON digital_development_route_facts(source_id,route_version) WHERE kind='客户样板确认';
CREATE INDEX digital_development_route_history ON digital_development_route_facts(source_id,sequence);
CREATE TRIGGER digital_development_route_history_immutable BEFORE UPDATE OR DELETE ON digital_development_route_facts
FOR EACH ROW EXECUTE FUNCTION guard_production_order_root_immutable();

-- Reuse the original pattern order, price snapshot, segments and wage qualification.
CREATE TABLE digital_development_pattern_links (
 source_id uuid PRIMARY KEY REFERENCES digital_production_sources(source_id),
 order_id uuid NOT NULL UNIQUE REFERENCES pattern_room_orders(order_id),
 linked_by uuid NOT NULL REFERENCES app_users(id),
 linked_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TRIGGER digital_development_pattern_link_immutable BEFORE UPDATE OR DELETE ON digital_development_pattern_links
FOR EACH ROW EXECUTE FUNCTION guard_production_order_root_immutable();
