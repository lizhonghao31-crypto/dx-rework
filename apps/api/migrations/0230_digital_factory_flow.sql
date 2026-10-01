-- Fixed whole-order secondary/QC/dispatch flow. No receipt, stock, wage or cutting quantities.
CREATE TABLE digital_factory_routes(
 preparation_id uuid PRIMARY KEY REFERENCES digital_bulk_cutting_completions(preparation_id),
 production_order_id uuid NOT NULL UNIQUE REFERENCES digital_production_orders(production_order_id),
 secondary_craft text NOT NULL CHECK(secondary_craft IN ('无','印花','绣花','印绣花')),
 created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE digital_factory_facts(
 fact_id uuid PRIMARY KEY,preparation_id uuid NOT NULL REFERENCES digital_factory_routes(preparation_id),
 sequence integer NOT NULL CHECK(sequence>0),kind text NOT NULL CHECK(kind IN ('工艺发出','工艺回仓','工艺沟通','仓库实际发厂','船样寄出','工厂到料','到料清点')),
 payload jsonb NOT NULL,actor_id uuid NOT NULL REFERENCES app_users(id),occurred_at timestamptz,recorded_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(preparation_id,sequence)
);
CREATE UNIQUE INDEX digital_factory_one_dispatch ON digital_factory_facts(preparation_id) WHERE kind='仓库实际发厂';
CREATE UNIQUE INDEX digital_factory_one_sample ON digital_factory_facts(preparation_id) WHERE kind='船样寄出';
CREATE UNIQUE INDEX digital_factory_one_count ON digital_factory_facts(preparation_id) WHERE kind='到料清点';
CREATE TABLE digital_factory_qc(
 check_id uuid PRIMARY KEY,sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,preparation_id uuid NOT NULL REFERENCES digital_factory_routes(preparation_id),
 return_fact_id uuid NOT NULL REFERENCES digital_factory_facts(fact_id),line_id uuid NOT NULL REFERENCES digital_production_po_lines(line_id),
 result text NOT NULL CHECK(result IN ('合格','需处理')),problem text NOT NULL,treatment text NOT NULL,
 attachment_ids uuid[] NOT NULL DEFAULT '{}',checked_by uuid NOT NULL REFERENCES app_users(id),checked_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TRIGGER digital_factory_route_immutable BEFORE UPDATE OR DELETE ON digital_factory_routes FOR EACH ROW EXECUTE FUNCTION guard_production_order_root_immutable();
CREATE TRIGGER digital_factory_fact_immutable BEFORE UPDATE OR DELETE ON digital_factory_facts FOR EACH ROW EXECUTE FUNCTION guard_production_order_root_immutable();
CREATE TRIGGER digital_factory_qc_immutable BEFORE UPDATE OR DELETE ON digital_factory_qc FOR EACH ROW EXECUTE FUNCTION guard_production_order_root_immutable();
INSERT INTO digital_production_deadline_policies(node_key,version,label,sla_seconds,warning_ratio) VALUES('bulk_ship_sample',1,'大货船样寄出',NULL,0.8);

CREATE OR REPLACE FUNCTION guard_sourcing_production_creation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_case sourcing_cases%ROWTYPE;
BEGIN
  SELECT * INTO source_case FROM sourcing_cases WHERE sourcing_case_id=NEW.sourcing_case_id FOR UPDATE;
  IF source_case.deleted_at IS NOT NULL OR NOT EXISTS (
    SELECT 1 FROM sourcing_approval_snapshots snapshot
    JOIN sourcing_contract_documents document USING(sourcing_approval_snapshot_id)
    JOIN operation_events event ON event.event_id=NEW.operation_event_id
    WHERE snapshot.sourcing_approval_snapshot_id=NEW.sourcing_approval_snapshot_id
      AND snapshot.sourcing_case_id=NEW.sourcing_case_id
      AND snapshot.sourcing_decision_id=NEW.sourcing_decision_id
      AND snapshot.decision_version=NEW.decision_version
      AND snapshot.sourcing_decision_id=(SELECT sourcing_decision_id FROM sourcing_decisions
        WHERE sourcing_case_id=NEW.sourcing_case_id ORDER BY decision_version DESC LIMIT 1)
      AND document.sourcing_contract_document_id=NEW.sourcing_contract_document_id
      AND document.status='ready' AND document.pdf_attachment_id IS NOT NULL
      AND document.contract_number=NEW.contract_number AND document.contract_version=NEW.contract_version
      AND snapshot.supplier_id=NEW.supplier_id AND snapshot.supplier_name_snapshot=NEW.supplier_name_snapshot
      AND snapshot.quantity=NEW.quantity AND snapshot.processes=NEW.processes
      AND snapshot.delivery_date IS NOT DISTINCT FROM NEW.delivery_date
      AND snapshot.gender IS NOT DISTINCT FROM NEW.gender
      AND snapshot.style_name_snapshot IS NOT DISTINCT FROM NEW.style_name_snapshot
      AND NEW.first_style_no=(SELECT style_no FROM sourcing_approval_snapshot_lines
        WHERE sourcing_approval_snapshot_id=NEW.sourcing_approval_snapshot_id ORDER BY position LIMIT 1)
      AND event.action='sourcing.production.dispatch' AND event.entity_type='sourcing_production_order'
      AND event.entity_id=NEW.production_order_id::text AND event.actor_id=NEW.dispatched_by
      AND event.authorization_capability='sourcing:contract:record'
      AND (CASE WHEN source_case.workflow_generation='digital_production_v1' THEN
        (event.actor_roles && ARRAY['root_superuser','warehouse_receiver']::text[] AND EXISTS(
          SELECT 1 FROM digital_production_child_links l JOIN digital_factory_routes r USING(production_order_id)
          JOIN digital_factory_facts f USING(preparation_id)
          WHERE l.module='sourcing' AND l.child_id=NEW.sourcing_case_id AND f.kind='仓库实际发厂'
            AND f.actor_id=event.actor_id AND f.occurred_at=NEW.dispatched_at
            AND f.payload->>'supplierId'=NEW.supplier_id::text
        )) ELSE (event.actor_roles @> ARRAY['root_superuser']::text[] OR
        (event.actor_roles @> ARRAY['order_merchandiser']::text[] AND event.actor_id=source_case.created_by)) END)
      AND event.after_state->>'contractDocumentId'=NEW.sourcing_contract_document_id::text
  ) THEN RAISE EXCEPTION 'dispatch requires current approved ready contract and authorized audit' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END;
$$;
