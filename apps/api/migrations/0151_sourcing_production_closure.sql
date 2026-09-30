-- SSP-09: optional supplier pilot, derived risks and personal read state; no delivery outbox.
CREATE TABLE sourcing_production_pilots (
 supplier_id uuid PRIMARY KEY REFERENCES supplier_catalog_items(supplier_id),
 enabled boolean NOT NULL,
 operation_event_id uuid NOT NULL REFERENCES operation_events(event_id),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE sourcing_production_alerts (
 alert_id uuid PRIMARY KEY,
 production_order_id uuid NOT NULL REFERENCES sourcing_production_orders(production_order_id),
 kind text NOT NULL CHECK(kind IN ('behind','high_risk','stale')),
 opened_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 resolved_at timestamptz,
 CHECK(resolved_at IS NULL OR resolved_at>=opened_at)
);
CREATE UNIQUE INDEX sourcing_production_one_active_alert ON sourcing_production_alerts(production_order_id) WHERE resolved_at IS NULL;
CREATE TABLE sourcing_production_alert_reads (
 alert_id uuid NOT NULL REFERENCES sourcing_production_alerts(alert_id),
 user_id uuid NOT NULL REFERENCES app_users(id),
 read_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(alert_id,user_id)
);
CREATE TABLE sourcing_production_receipt_links (
 receipt_id uuid PRIMARY KEY REFERENCES receiving_receipts(receipt_id),
 production_order_id uuid NOT NULL REFERENCES sourcing_production_shipments(production_order_id),
 operation_event_id uuid NOT NULL REFERENCES operation_events(event_id),
 linked_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX sourcing_production_receipt_order ON sourcing_production_receipt_links(production_order_id);
CREATE FUNCTION guard_sourcing_production_receipt_link() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM receiving_receipts receipt
  JOIN sourcing_production_shipments shipment ON shipment.production_order_id=NEW.production_order_id
  JOIN operation_events event ON event.event_id=NEW.operation_event_id
  WHERE receipt.receipt_id=NEW.receipt_id AND receipt.operation_event_id=NEW.operation_event_id
   AND upper(trim(receipt.style_no))=upper(trim(shipment.first_style_no))
   AND (receipt.received_at AT TIME ZONE 'Asia/Shanghai')::date>=shipment.shipped_on
   AND event.action='receiving.receipt.create' AND event.entity_id=NEW.receipt_id::text
   AND event.after_state->>'productionOrderId'=NEW.production_order_id::text)
 THEN RAISE EXCEPTION 'receipt link must match shipped first style and actual receipt audit' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER sourcing_production_receipt_link_guard BEFORE INSERT ON sourcing_production_receipt_links
 FOR EACH ROW EXECUTE FUNCTION guard_sourcing_production_receipt_link();
CREATE TRIGGER sourcing_production_receipt_link_immutable BEFORE UPDATE OR DELETE ON sourcing_production_receipt_links
 FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER sourcing_production_receipt_link_no_truncate BEFORE TRUNCATE ON sourcing_production_receipt_links
 FOR EACH STATEMENT EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER sourcing_production_alert_read_immutable BEFORE UPDATE OR DELETE ON sourcing_production_alert_reads
 FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
