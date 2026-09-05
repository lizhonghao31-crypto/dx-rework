-- SSP-06. Dispatch is independent of finance reconciliation (V1.2).
-- These immutable execution facts deliberately contain no prices or bank details.
CREATE TABLE sourcing_production_orders (
  production_order_id uuid PRIMARY KEY,
  sourcing_case_id uuid NOT NULL UNIQUE REFERENCES sourcing_cases(sourcing_case_id),
  sourcing_approval_snapshot_id uuid NOT NULL UNIQUE REFERENCES sourcing_approval_snapshots(sourcing_approval_snapshot_id),
  sourcing_decision_id uuid NOT NULL UNIQUE REFERENCES sourcing_decisions(sourcing_decision_id),
  decision_version integer NOT NULL CHECK(decision_version>0),
  sourcing_contract_document_id uuid NOT NULL UNIQUE REFERENCES sourcing_contract_documents(sourcing_contract_document_id),
  contract_number text NOT NULL,
  contract_version integer NOT NULL CHECK(contract_version>0),
  supplier_id uuid NOT NULL REFERENCES supplier_catalog_items(supplier_id),
  supplier_name_snapshot text NOT NULL,
  gender text CHECK(gender IN ('男装','女装')),
  style_name_snapshot text,
  quantity integer NOT NULL CHECK(quantity BETWEEN 1 AND 10000000),
  processes text[] NOT NULL,
  delivery_date date,
  first_style_no text NOT NULL,
  dispatched_by uuid NOT NULL REFERENCES app_users(id),
  dispatched_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  operation_event_id uuid NOT NULL UNIQUE REFERENCES operation_events(event_id)
);
CREATE INDEX sourcing_production_case_idx ON sourcing_production_orders(sourcing_case_id,decision_version DESC);
CREATE INDEX sourcing_production_supplier_idx ON sourcing_production_orders(supplier_id,dispatched_at DESC);

CREATE TABLE sourcing_production_lines (
  production_order_id uuid NOT NULL REFERENCES sourcing_production_orders(production_order_id),
  position integer NOT NULL CHECK(position BETWEEN 1 AND 20),
  style_no text NOT NULL,
  alternate_style_no text,
  color text,
  quantity integer NOT NULL CHECK(quantity BETWEEN 1 AND 10000000),
  PRIMARY KEY(production_order_id,position)
);
CREATE TABLE sourcing_production_transitions (
  production_transition_id uuid PRIMARY KEY,
  production_order_id uuid NOT NULL REFERENCES sourcing_production_orders(production_order_id),
  sequence integer NOT NULL CHECK(sequence BETWEEN 1 AND 3),
  status text NOT NULL CHECK(status IN ('in_production','production_completed','shipped')),
  business_date date NOT NULL,
  actor_id uuid NOT NULL REFERENCES app_users(id),
  operation_event_id uuid NOT NULL UNIQUE REFERENCES operation_events(event_id),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(production_order_id,sequence)
);

CREATE FUNCTION guard_sourcing_production_creation() RETURNS trigger LANGUAGE plpgsql AS $$
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
      AND (event.actor_roles @> ARRAY['root_superuser']::text[] OR
        (event.actor_roles @> ARRAY['order_merchandiser']::text[] AND event.actor_id=source_case.created_by))
      AND event.after_state->>'contractDocumentId'=NEW.sourcing_contract_document_id::text
  ) THEN RAISE EXCEPTION 'dispatch requires current approved ready contract and authorized audit' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER sourcing_production_orders_guard BEFORE INSERT ON sourcing_production_orders
  FOR EACH ROW EXECUTE FUNCTION guard_sourcing_production_creation();

CREATE FUNCTION guard_sourcing_production_line() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM sourcing_production_orders production
    JOIN sourcing_approval_snapshot_lines line USING(sourcing_approval_snapshot_id)
    WHERE production.production_order_id=NEW.production_order_id AND line.position=NEW.position
      AND line.style_no=NEW.style_no AND line.quantity=NEW.quantity
      AND line.alternate_style_no IS NOT DISTINCT FROM NEW.alternate_style_no
      AND line.color IS NOT DISTINCT FROM NEW.color)
  THEN RAISE EXCEPTION 'production line must equal approved line' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER sourcing_production_lines_guard BEFORE INSERT ON sourcing_production_lines
  FOR EACH ROW EXECUTE FUNCTION guard_sourcing_production_line();

CREATE FUNCTION guard_sourcing_production_transition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous sourcing_production_transitions%ROWTYPE; production sourcing_production_orders%ROWTYPE; expected_action text;
BEGIN
  SELECT * INTO production FROM sourcing_production_orders WHERE production_order_id=NEW.production_order_id FOR UPDATE;
  SELECT * INTO previous FROM sourcing_production_transitions WHERE production_order_id=NEW.production_order_id ORDER BY sequence DESC LIMIT 1;
  IF previous.production_transition_id IS NULL THEN
    IF NEW.sequence<>1 OR NEW.status<>'in_production' OR NEW.operation_event_id<>production.operation_event_id
      OR NEW.actor_id<>production.dispatched_by THEN
      RAISE EXCEPTION 'production must start with dispatch' USING ERRCODE='55000'; END IF;
    expected_action := 'sourcing.production.dispatch';
  ELSE
    IF NEW.sequence<>previous.sequence+1 OR NEW.business_date<previous.business_date OR NOT (
      (previous.status='in_production' AND NEW.status='production_completed') OR
      (previous.status='production_completed' AND NEW.status='shipped')) THEN
      RAISE EXCEPTION 'illegal production transition' USING ERRCODE='55000'; END IF;
    expected_action := CASE NEW.status WHEN 'production_completed' THEN 'sourcing.production.complete' ELSE 'sourcing.production.ship' END;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM operation_events event WHERE event.event_id=NEW.operation_event_id
    AND event.actor_id=NEW.actor_id AND event.action=expected_action
    AND event.entity_type='sourcing_production_order' AND event.entity_id=NEW.production_order_id::text)
  THEN RAISE EXCEPTION 'production transition requires matching audit' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER sourcing_production_transitions_guard BEFORE INSERT ON sourcing_production_transitions
  FOR EACH ROW EXECUTE FUNCTION guard_sourcing_production_transition();

-- Check the complete immutable order at transaction commit, after inserting all lines.
CREATE FUNCTION validate_sourcing_production_complete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT COALESCE(sum(quantity),0) FROM sourcing_production_lines WHERE production_order_id=NEW.production_order_id)<>NEW.quantity
    OR (SELECT count(*) FROM sourcing_production_lines WHERE production_order_id=NEW.production_order_id)<>
       (SELECT count(*) FROM sourcing_approval_snapshot_lines WHERE sourcing_approval_snapshot_id=NEW.sourcing_approval_snapshot_id)
    OR NOT EXISTS(SELECT 1 FROM sourcing_production_transitions WHERE production_order_id=NEW.production_order_id AND sequence=1)
  THEN RAISE EXCEPTION 'production order requires all approved lines and initial transition' USING ERRCODE='55000'; END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER sourcing_production_complete AFTER INSERT ON sourcing_production_orders
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_sourcing_production_complete();

DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['sourcing_production_orders','sourcing_production_lines','sourcing_production_transitions'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation()',table_name||'_immutable',table_name);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION reject_operation_event_mutation()',table_name||'_no_truncate',table_name);
  END LOOP;
END; $$;
