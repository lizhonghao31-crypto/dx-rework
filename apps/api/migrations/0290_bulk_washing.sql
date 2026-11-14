-- Normal bulk washing keeps immutable adopted arrangements and events.
-- Native factory allocation, receipt and packing quantities are not copied.
CREATE TABLE digital_bulk_washing_plans (
 plan_id uuid PRIMARY KEY,
 production_order_id uuid NOT NULL REFERENCES digital_production_orders(production_order_id),
 line_id uuid NOT NULL REFERENCES digital_production_po_lines(line_id),
 version integer NOT NULL CHECK(version>0),
 document jsonb NOT NULL CHECK(jsonb_typeof(document)='object'),
 created_by uuid NOT NULL REFERENCES app_users(id),
 recorded_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(production_order_id,line_id,version),
 UNIQUE(plan_id,production_order_id)
);
CREATE TABLE digital_bulk_washing_events (
 event_id uuid PRIMARY KEY,
 production_order_id uuid NOT NULL REFERENCES digital_production_orders(production_order_id),
 plan_id uuid NOT NULL,
 scope_id text NOT NULL,
 quantity_version text NOT NULL,
 sequence integer NOT NULL CHECK(sequence>0),
 kind text NOT NULL CHECK(kind IN ('send','return','factory_start','factory_complete','inspection','receipt_link','void')),
 payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),
 occurred_at timestamptz,
 recorded_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 actor_id uuid NOT NULL REFERENCES app_users(id),
 FOREIGN KEY(plan_id,production_order_id) REFERENCES digital_bulk_washing_plans(plan_id,production_order_id),
 UNIQUE(production_order_id,scope_id,sequence)
);
ALTER TABLE digital_production_po_lines ADD COLUMN bulk_washing_plan_id uuid REFERENCES digital_bulk_washing_plans(plan_id);
-- Disposable projection, always checked against the current native quantity
-- version. Immutable events above remain the only washing evidence.
CREATE TABLE digital_bulk_washing_receipt_coverage (
 receipt_id uuid PRIMARY KEY REFERENCES receiving_receipts(receipt_id),
 production_order_id uuid NOT NULL REFERENCES digital_production_orders(production_order_id),
 line_id uuid NOT NULL REFERENCES digital_production_po_lines(line_id),
 quantity_version text NOT NULL,
 qualified bigint CHECK(qualified>=0),
 plan_id uuid REFERENCES digital_bulk_washing_plans(plan_id),
 factory_sources jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(factory_sources)='array'),
 refreshed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TRIGGER digital_bulk_washing_plans_immutable BEFORE UPDATE OR DELETE ON digital_bulk_washing_plans
 FOR EACH ROW EXECUTE FUNCTION guard_production_order_root_immutable();
CREATE TRIGGER digital_bulk_washing_events_immutable BEFORE UPDATE OR DELETE ON digital_bulk_washing_events
 FOR EACH ROW EXECUTE FUNCTION guard_production_order_root_immutable();
CREATE TRIGGER digital_bulk_washing_plans_no_truncate BEFORE TRUNCATE ON digital_bulk_washing_plans
 FOR EACH STATEMENT EXECUTE FUNCTION guard_production_order_root_immutable();
CREATE TRIGGER digital_bulk_washing_events_no_truncate BEFORE TRUNCATE ON digital_bulk_washing_events
 FOR EACH STATEMENT EXECUTE FUNCTION guard_production_order_root_immutable();
CREATE TRIGGER journey_fact_dirty BEFORE INSERT ON digital_bulk_washing_plans
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''order''::text kind,($1->>''production_order_id'')::uuid id');
CREATE TRIGGER journey_fact_dirty BEFORE INSERT ON digital_bulk_washing_events
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''order''::text kind,($1->>''production_order_id'')::uuid id');
