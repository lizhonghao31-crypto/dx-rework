-- P10: immutable technical instructions; budgets are never part of this DTO.
CREATE TABLE digital_instruction_documents (
 production_order_id uuid PRIMARY KEY REFERENCES digital_production_orders(production_order_id),
 version integer NOT NULL CHECK(version>0), order_version integer NOT NULL,
 document jsonb NOT NULL, source_round integer,
 updated_by uuid NOT NULL REFERENCES app_users(id), updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 published_version integer
);
CREATE TABLE digital_instruction_versions (
 production_order_id uuid NOT NULL REFERENCES digital_production_orders(production_order_id),
 version integer NOT NULL, order_version integer NOT NULL, document jsonb NOT NULL,
 order_snapshot jsonb NOT NULL, source_round integer,
 published_by uuid NOT NULL REFERENCES app_users(id), published_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(production_order_id,version)
);
CREATE TRIGGER digital_instruction_versions_immutable BEFORE UPDATE OR DELETE ON digital_instruction_versions
 FOR EACH ROW EXECUTE FUNCTION guard_production_order_root_immutable();
CREATE TABLE digital_instruction_attachment_bindings (
 production_order_id uuid NOT NULL REFERENCES digital_production_orders(production_order_id),
 attachment_id uuid NOT NULL REFERENCES attachments(attachment_id),
 PRIMARY KEY(production_order_id,attachment_id)
);
CREATE TRIGGER digital_instruction_attachments_immutable BEFORE UPDATE OR DELETE ON digital_instruction_attachment_bindings
 FOR EACH ROW EXECUTE FUNCTION guard_production_order_root_immutable();
CREATE TABLE digital_instruction_date_requests (
 request_id uuid PRIMARY KEY, production_order_id uuid NOT NULL REFERENCES digital_production_orders(production_order_id),
 order_version integer NOT NULL, old_date date, new_date date NOT NULL, reason text NOT NULL,
 requested_by uuid NOT NULL REFERENCES app_users(id), requested_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE digital_instruction_date_decisions (
 request_id uuid PRIMARY KEY REFERENCES digital_instruction_date_requests(request_id),
 approved boolean NOT NULL, decided_by uuid NOT NULL REFERENCES app_users(id), decided_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TRIGGER digital_instruction_dates_immutable BEFORE UPDATE OR DELETE ON digital_instruction_date_requests
 FOR EACH ROW EXECUTE FUNCTION guard_production_order_root_immutable();
CREATE TRIGGER digital_instruction_decisions_immutable BEFORE UPDATE OR DELETE ON digital_instruction_date_decisions
 FOR EACH ROW EXECUTE FUNCTION guard_production_order_root_immutable();
ALTER TABLE digital_production_notification_events ADD COLUMN instruction_order_id uuid REFERENCES digital_production_orders(production_order_id);
ALTER TABLE digital_production_notification_events DROP CONSTRAINT digital_notification_one_target;
ALTER TABLE digital_production_notification_events ADD CONSTRAINT digital_notification_one_target CHECK(num_nonnulls(task_id,todo_id,development_source_id,instruction_order_id)=1);
CREATE TABLE digital_instruction_notices (
 event_id uuid PRIMARY KEY REFERENCES digital_production_notification_events(event_id),
 version integer, title text NOT NULL
);
