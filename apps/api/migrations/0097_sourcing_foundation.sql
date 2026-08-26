-- Sourcing PR02 foundation: append-only facts, state history and exact role capabilities.
-- V1 uses lane_key='garment_processing'; the stable lane key keeps future process lanes additive.

DROP TRIGGER capability_catalog_no_insert ON capability_catalog;
DROP TRIGGER role_capabilities_no_insert ON role_capabilities;

INSERT INTO capability_catalog(capability,display_name,description) VALUES
  ('sourcing:inquiry:create','创建报价选厂询价','基于正式 ERP 订单创建报价选厂案例'),
  ('sourcing:price:quote','IE 提供加工价格','IE 记录生产管理调整前的加工价格依据'),
  ('sourcing:decision:record','记录选厂定价决定','生产主管引用 IE 价格并记录不可覆盖的供应商与调整价格决定'),
  ('sourcing:owner:approve','老板审批选厂决定','老板最终批准或驳回生产管理的选厂定价决定'),
  ('sourcing:contract:record','登记合同执行','跟单登记与当前选厂决定对应的合同'),
  ('sourcing:factory_change:request','发起中途换厂','跟单发起从当前工厂改到另一工厂的核实请求'),
  ('sourcing:factory_change:verify','核实中途换厂','生产主管批准或驳回中途换厂请求'),
  ('sourcing:finance:reconcile','财务核对报价选厂','应付会计核对供应商、单价、数量与总额'),
  ('sourcing:exception:verify','核实报价选厂差异','生产主管核实财务发现的报价选厂差异')
ON CONFLICT (capability) DO NOTHING;

INSERT INTO role_capabilities(role_code,capability) VALUES
  ('order_merchandiser','sourcing:inquiry:create'),
  ('ie_reviewer','sourcing:price:quote'),
  ('production_management','sourcing:decision:record'),
  ('owner_group','sourcing:owner:approve'),
  ('order_merchandiser','sourcing:contract:record'),
  ('order_merchandiser','sourcing:factory_change:request'),
  ('production_management','sourcing:factory_change:verify'),
  ('factory_payables','sourcing:finance:reconcile'),
  ('production_management','sourcing:exception:verify')
ON CONFLICT DO NOTHING;

CREATE TRIGGER capability_catalog_no_insert
  BEFORE INSERT ON capability_catalog FOR EACH ROW
  EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER role_capabilities_no_insert
  BEFORE INSERT ON role_capabilities FOR EACH ROW
  EXECUTE FUNCTION reject_operation_event_mutation();

CREATE TABLE sourcing_cases (
  sourcing_case_id uuid PRIMARY KEY,
  erp_order_id text NOT NULL CHECK(length(btrim(erp_order_id)) BETWEEN 1 AND 200),
  erp_order_no text NOT NULL CHECK(length(btrim(erp_order_no)) BETWEEN 1 AND 100),
  style_no text NOT NULL CHECK(length(btrim(style_no)) BETWEEN 1 AND 100),
  lane_key text NOT NULL CHECK(lane_key ~ '^[a-z][a-z0-9_]{2,63}$'),
  order_quantity integer NOT NULL CHECK(order_quantity > 0),
  created_by uuid NOT NULL REFERENCES app_users(id),
  operation_event_id uuid NOT NULL UNIQUE REFERENCES operation_events(event_id),
  request_id text NOT NULL CHECK(request_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  creation_reason text NOT NULL CHECK(length(btrim(creation_reason)) BETWEEN 1 AND 500),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(erp_order_id,lane_key)
);
CREATE INDEX sourcing_cases_order_no_idx ON sourcing_cases(erp_order_no,lane_key);
CREATE INDEX sourcing_cases_created_idx ON sourcing_cases(created_at DESC);

CREATE TABLE sourcing_ie_quotes (
  sourcing_ie_quote_id uuid PRIMARY KEY,
  sourcing_case_id uuid NOT NULL REFERENCES sourcing_cases(sourcing_case_id),
  quote_version integer NOT NULL CHECK(quote_version > 0),
  unit_price numeric(18,4) NOT NULL CHECK(unit_price > 0),
  quantity integer NOT NULL CHECK(quantity > 0),
  total_amount numeric(18,2) NOT NULL CHECK(total_amount > 0),
  quote_reason text NOT NULL CHECK(length(btrim(quote_reason)) BETWEEN 1 AND 500),
  quoted_by uuid NOT NULL REFERENCES app_users(id),
  operation_event_id uuid NOT NULL UNIQUE REFERENCES operation_events(event_id),
  request_id text NOT NULL CHECK(request_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  quoted_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(sourcing_case_id,quote_version),
  CHECK(total_amount=round(unit_price*quantity,2))
);
CREATE INDEX sourcing_ie_quotes_case_idx
  ON sourcing_ie_quotes(sourcing_case_id,quote_version DESC);

CREATE TABLE sourcing_decisions (
  sourcing_decision_id uuid PRIMARY KEY,
  sourcing_case_id uuid NOT NULL REFERENCES sourcing_cases(sourcing_case_id),
  decision_version integer NOT NULL CHECK(decision_version > 0),
  source_type text NOT NULL CHECK(source_type IN ('initial','management_revision','factory_change')),
  source_ie_quote_id uuid REFERENCES sourcing_ie_quotes(sourcing_ie_quote_id),
  supersedes_decision_id uuid REFERENCES sourcing_decisions(sourcing_decision_id),
  source_change_request_id uuid,
  supplier_id uuid NOT NULL REFERENCES supplier_catalog_items(supplier_id),
  supplier_code_snapshot text NOT NULL CHECK(length(btrim(supplier_code_snapshot)) BETWEEN 1 AND 32),
  supplier_name_snapshot text NOT NULL CHECK(length(btrim(supplier_name_snapshot)) BETWEEN 1 AND 200),
  unit_price numeric(18,4) NOT NULL CHECK(unit_price > 0),
  quantity integer NOT NULL CHECK(quantity > 0),
  total_amount numeric(18,2) NOT NULL CHECK(total_amount > 0),
  decision_reason text NOT NULL CHECK(length(btrim(decision_reason)) BETWEEN 1 AND 500),
  decided_by uuid NOT NULL REFERENCES app_users(id),
  operation_event_id uuid NOT NULL UNIQUE REFERENCES operation_events(event_id),
  request_id text NOT NULL CHECK(request_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  decided_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(sourcing_case_id,decision_version),
  CHECK(total_amount=round(unit_price*quantity,2)),
  CHECK(
    (source_type='initial' AND source_ie_quote_id IS NOT NULL
      AND supersedes_decision_id IS NULL AND source_change_request_id IS NULL)
    OR
    (source_type='management_revision' AND source_ie_quote_id IS NOT NULL
      AND supersedes_decision_id IS NOT NULL AND source_change_request_id IS NULL)
    OR
    (source_type='factory_change' AND source_ie_quote_id IS NULL
      AND supersedes_decision_id IS NOT NULL AND source_change_request_id IS NOT NULL)
  )
);
CREATE INDEX sourcing_decisions_case_history_idx
  ON sourcing_decisions(sourcing_case_id,decision_version DESC);

CREATE TABLE sourcing_owner_decisions (
  sourcing_owner_decision_id uuid PRIMARY KEY,
  sourcing_case_id uuid NOT NULL REFERENCES sourcing_cases(sourcing_case_id),
  sourcing_decision_id uuid NOT NULL UNIQUE REFERENCES sourcing_decisions(sourcing_decision_id),
  decision text NOT NULL CHECK(decision IN ('approved','rejected')),
  decision_reason text NOT NULL CHECK(length(btrim(decision_reason)) BETWEEN 1 AND 500),
  decided_by uuid NOT NULL REFERENCES app_users(id),
  operation_event_id uuid NOT NULL UNIQUE REFERENCES operation_events(event_id),
  request_id text NOT NULL CHECK(request_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  decided_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX sourcing_owner_decisions_case_idx
  ON sourcing_owner_decisions(sourcing_case_id,decided_at DESC);

CREATE TABLE sourcing_contract_executions (
  sourcing_contract_id uuid PRIMARY KEY,
  sourcing_case_id uuid NOT NULL REFERENCES sourcing_cases(sourcing_case_id),
  sourcing_decision_id uuid NOT NULL UNIQUE REFERENCES sourcing_decisions(sourcing_decision_id),
  contract_reference text NOT NULL CHECK(length(btrim(contract_reference)) BETWEEN 1 AND 200),
  signed_on date NOT NULL,
  execution_reason text NOT NULL CHECK(length(btrim(execution_reason)) BETWEEN 1 AND 500),
  recorded_by uuid NOT NULL REFERENCES app_users(id),
  operation_event_id uuid NOT NULL UNIQUE REFERENCES operation_events(event_id),
  request_id text NOT NULL CHECK(request_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  recorded_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX sourcing_contracts_case_idx
  ON sourcing_contract_executions(sourcing_case_id,recorded_at DESC);

CREATE TABLE sourcing_factory_change_requests (
  factory_change_request_id uuid PRIMARY KEY,
  sourcing_case_id uuid NOT NULL REFERENCES sourcing_cases(sourcing_case_id),
  from_decision_id uuid NOT NULL REFERENCES sourcing_decisions(sourcing_decision_id),
  proposed_supplier_id uuid NOT NULL REFERENCES supplier_catalog_items(supplier_id),
  proposed_supplier_code_snapshot text NOT NULL
    CHECK(length(btrim(proposed_supplier_code_snapshot)) BETWEEN 1 AND 32),
  proposed_supplier_name_snapshot text NOT NULL
    CHECK(length(btrim(proposed_supplier_name_snapshot)) BETWEEN 1 AND 200),
  proposed_unit_price numeric(18,4) NOT NULL CHECK(proposed_unit_price > 0),
  proposed_quantity integer NOT NULL CHECK(proposed_quantity > 0),
  proposed_total_amount numeric(18,2) NOT NULL CHECK(proposed_total_amount > 0),
  change_reason text NOT NULL CHECK(length(btrim(change_reason)) BETWEEN 1 AND 500),
  requested_by uuid NOT NULL REFERENCES app_users(id),
  operation_event_id uuid NOT NULL UNIQUE REFERENCES operation_events(event_id),
  request_id text NOT NULL CHECK(request_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  requested_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK(proposed_total_amount=round(proposed_unit_price*proposed_quantity,2))
);
CREATE INDEX sourcing_factory_change_requests_case_idx
  ON sourcing_factory_change_requests(sourcing_case_id,requested_at DESC);

CREATE TABLE sourcing_factory_change_decisions (
  factory_change_decision_id uuid PRIMARY KEY,
  factory_change_request_id uuid NOT NULL UNIQUE
    REFERENCES sourcing_factory_change_requests(factory_change_request_id),
  decision text NOT NULL CHECK(decision IN ('approved','rejected')),
  verification_reason text NOT NULL CHECK(length(btrim(verification_reason)) BETWEEN 1 AND 500),
  verified_by uuid NOT NULL REFERENCES app_users(id),
  operation_event_id uuid NOT NULL UNIQUE REFERENCES operation_events(event_id),
  request_id text NOT NULL CHECK(request_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  verified_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE sourcing_decisions
  ADD CONSTRAINT sourcing_decisions_change_request_fk
  FOREIGN KEY(source_change_request_id)
  REFERENCES sourcing_factory_change_requests(factory_change_request_id);

CREATE TABLE sourcing_finance_reconciliations (
  sourcing_reconciliation_id uuid PRIMARY KEY,
  sourcing_case_id uuid NOT NULL REFERENCES sourcing_cases(sourcing_case_id),
  reconciliation_version integer NOT NULL CHECK(reconciliation_version > 0),
  sourcing_decision_id uuid NOT NULL REFERENCES sourcing_decisions(sourcing_decision_id),
  sourcing_contract_id uuid NOT NULL REFERENCES sourcing_contract_executions(sourcing_contract_id),
  actual_supplier_id uuid NOT NULL REFERENCES supplier_catalog_items(supplier_id),
  actual_unit_price numeric(18,4) NOT NULL CHECK(actual_unit_price > 0),
  actual_quantity integer NOT NULL CHECK(actual_quantity > 0),
  actual_total_amount numeric(18,2) NOT NULL CHECK(actual_total_amount > 0),
  result text NOT NULL CHECK(result IN ('match','difference')),
  difference_fields text[] NOT NULL DEFAULT '{}'::text[],
  difference_reason text,
  reconciled_by uuid NOT NULL REFERENCES app_users(id),
  operation_event_id uuid NOT NULL UNIQUE REFERENCES operation_events(event_id),
  request_id text NOT NULL CHECK(request_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  reconciled_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(sourcing_case_id,reconciliation_version),
  CHECK(actual_total_amount=round(actual_unit_price*actual_quantity,2)),
  CHECK(
    (result='match' AND cardinality(difference_fields)=0 AND difference_reason IS NULL)
    OR
    (result='difference' AND cardinality(difference_fields)>0
      AND length(btrim(difference_reason)) BETWEEN 1 AND 500)
  ),
  CHECK(
    difference_fields <@ ARRAY['supplier','unit_price','quantity','total_amount']::text[]
    AND array_position(difference_fields,NULL) IS NULL
  )
);
CREATE INDEX sourcing_reconciliations_case_idx
  ON sourcing_finance_reconciliations(sourcing_case_id,reconciliation_version DESC);

CREATE TABLE sourcing_case_transitions (
  sourcing_transition_id uuid PRIMARY KEY,
  sourcing_case_id uuid NOT NULL REFERENCES sourcing_cases(sourcing_case_id),
  sequence integer NOT NULL CHECK(sequence > 0),
  from_status text,
  to_status text NOT NULL CHECK(to_status IN (
    'pending_ie_quote',
    'pending_management_decision',
    'pending_owner_approval',
    'pending_contract',
    'pending_finance_reconciliation',
    'pending_factory_change_verification',
    'pending_exception_verification',
    'closed'
  )),
  business_action text NOT NULL CHECK(business_action IN (
    'created',
    'ie_price_quoted',
    'management_decision_recorded',
    'owner_approved',
    'owner_rejected',
    'contract_recorded',
    'factory_change_requested',
    'factory_change_approved',
    'factory_change_rejected',
    'finance_matched',
    'finance_difference',
    'exception_reopened_for_contract',
    'exception_reopened_for_reconciliation',
    'exception_closed'
  )),
  transition_reason text,
  actor_id uuid NOT NULL REFERENCES app_users(id),
  operation_event_id uuid NOT NULL UNIQUE REFERENCES operation_events(event_id),
  request_id text NOT NULL CHECK(request_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  transitioned_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(sourcing_case_id,sequence),
  CHECK(from_status IS NULL OR from_status IN (
    'pending_ie_quote',
    'pending_management_decision',
    'pending_owner_approval',
    'pending_contract',
    'pending_finance_reconciliation',
    'pending_factory_change_verification',
    'pending_exception_verification',
    'closed'
  )),
  CHECK(transition_reason IS NULL OR length(btrim(transition_reason)) BETWEEN 1 AND 500)
);
CREATE INDEX sourcing_case_transitions_current_idx
  ON sourcing_case_transitions(sourcing_case_id,sequence DESC);

CREATE VIEW current_sourcing_cases AS
  SELECT
    sourcing_case.sourcing_case_id,
    sourcing_case.erp_order_id,
    sourcing_case.erp_order_no,
    sourcing_case.style_no,
    sourcing_case.lane_key,
    sourcing_case.order_quantity,
    current_transition.to_status AS status,
    current_transition.sequence AS version,
    sourcing_case.created_by,
    sourcing_case.created_at,
    current_transition.transitioned_at AS updated_at
  FROM sourcing_cases sourcing_case
  JOIN LATERAL (
    SELECT transition_row.to_status,transition_row.sequence,transition_row.transitioned_at
    FROM sourcing_case_transitions transition_row
    WHERE transition_row.sourcing_case_id=sourcing_case.sourcing_case_id
    ORDER BY transition_row.sequence DESC
    LIMIT 1
  ) current_transition ON true;

CREATE VIEW current_sourcing_decisions AS
  SELECT DISTINCT ON(decision_row.sourcing_case_id)
    decision_row.*
  FROM sourcing_decisions decision_row
  ORDER BY decision_row.sourcing_case_id,decision_row.decision_version DESC;

CREATE OR REPLACE FUNCTION sourcing_require_operation_event(
  required_event_id uuid,
  required_request_id text,
  required_actor_id uuid,
  required_action text,
  required_capability text,
  required_case_id uuid,
  required_reason text
) RETURNS void LANGUAGE plpgsql STABLE AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM operation_events event_row
    WHERE event_row.event_id=required_event_id
      AND event_row.request_id=required_request_id
      AND event_row.actor_id=required_actor_id
      AND event_row.action=required_action
      AND event_row.authorization_capability=required_capability
      AND event_row.entity_type='sourcing_case'
      AND event_row.entity_id=required_case_id::text
      AND event_row.reason IS NOT DISTINCT FROM required_reason
  ) THEN
    RAISE EXCEPTION 'sourcing write requires the matching immutable operation event'
      USING ERRCODE='55000';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION sourcing_current_status(required_case_id uuid)
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT transition_row.to_status
  FROM sourcing_case_transitions transition_row
  WHERE transition_row.sourcing_case_id=required_case_id
  ORDER BY transition_row.sequence DESC
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION sourcing_require_active_factory(
  required_supplier_id uuid,
  required_supplier_code text,
  required_supplier_name text
) RETURNS void LANGUAGE plpgsql STABLE AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM current_supplier_catalog supplier
    WHERE supplier.supplier_id=required_supplier_id
      AND supplier.supplier_type='factory'
      AND supplier.active=true
      AND supplier.supplier_code=required_supplier_code
      AND supplier.supplier_name=required_supplier_name
  ) THEN
    RAISE EXCEPTION 'sourcing supplier must be the current active factory snapshot'
      USING ERRCODE='23514';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION guard_sourcing_case_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM sourcing_require_operation_event(
    NEW.operation_event_id,NEW.request_id,NEW.created_by,
    'sourcing.case.create','sourcing:inquiry:create',
    NEW.sourcing_case_id,NEW.creation_reason
  );
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION guard_sourcing_ie_quote_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  source_case sourcing_cases%ROWTYPE;
  previous_version integer;
BEGIN
  SELECT * INTO source_case FROM sourcing_cases
  WHERE sourcing_case_id=NEW.sourcing_case_id FOR UPDATE;
  SELECT COALESCE(max(quote_version),0) INTO previous_version
  FROM sourcing_ie_quotes WHERE sourcing_case_id=NEW.sourcing_case_id;
  IF source_case.sourcing_case_id IS NULL
    OR sourcing_current_status(NEW.sourcing_case_id)<>'pending_ie_quote'
    OR NEW.quote_version<>previous_version+1
    OR NEW.quantity<>source_case.order_quantity THEN
    RAISE EXCEPTION 'IE quote must price the immutable order quantity in pending IE quote state'
      USING ERRCODE='23514';
  END IF;
  PERFORM sourcing_require_operation_event(
    NEW.operation_event_id,NEW.request_id,NEW.quoted_by,
    'sourcing.ie_price.quote','sourcing:price:quote',
    NEW.sourcing_case_id,NEW.quote_reason
  );
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION guard_sourcing_decision_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  source_case sourcing_cases%ROWTYPE;
  current_quote sourcing_ie_quotes%ROWTYPE;
  previous_decision sourcing_decisions%ROWTYPE;
  previous_owner_decision sourcing_owner_decisions%ROWTYPE;
  source_change sourcing_factory_change_requests%ROWTYPE;
  source_verification sourcing_factory_change_decisions%ROWTYPE;
BEGIN
  SELECT * INTO source_case FROM sourcing_cases
  WHERE sourcing_case_id=NEW.sourcing_case_id FOR UPDATE;
  IF source_case.sourcing_case_id IS NULL OR NEW.quantity<>source_case.order_quantity THEN
    RAISE EXCEPTION 'sourcing decision quantity must match the immutable order quantity'
      USING ERRCODE='23514';
  END IF;
  PERFORM sourcing_require_active_factory(
    NEW.supplier_id,NEW.supplier_code_snapshot,NEW.supplier_name_snapshot
  );
  SELECT * INTO previous_decision
  FROM sourcing_decisions
  WHERE sourcing_case_id=NEW.sourcing_case_id
  ORDER BY decision_version DESC
  LIMIT 1;

  IF NEW.source_type IN ('initial','management_revision') THEN
    SELECT * INTO current_quote
    FROM sourcing_ie_quotes
    WHERE sourcing_case_id=NEW.sourcing_case_id
    ORDER BY quote_version DESC
    LIMIT 1;
    IF sourcing_current_status(NEW.sourcing_case_id)<>'pending_management_decision'
      OR current_quote.sourcing_ie_quote_id IS NULL
      OR NEW.source_ie_quote_id<>current_quote.sourcing_ie_quote_id THEN
      RAISE EXCEPTION 'management decision must reference the current IE quote'
        USING ERRCODE='23514';
    END IF;
    IF NEW.source_type='initial' THEN
      IF previous_decision.sourcing_decision_id IS NOT NULL
        OR NEW.decision_version<>1
        OR NEW.supersedes_decision_id IS NOT NULL THEN
        RAISE EXCEPTION 'first management decision must be version 1'
          USING ERRCODE='23514';
      END IF;
    ELSE
      SELECT * INTO previous_owner_decision
      FROM sourcing_owner_decisions
      WHERE sourcing_decision_id=previous_decision.sourcing_decision_id
        AND decision='rejected';
      IF previous_decision.sourcing_decision_id IS NULL
        OR previous_owner_decision.sourcing_owner_decision_id IS NULL
        OR NEW.decision_version<>previous_decision.decision_version+1
        OR NEW.supersedes_decision_id<>previous_decision.sourcing_decision_id THEN
        RAISE EXCEPTION 'management revision must supersede the owner-rejected decision'
          USING ERRCODE='23514';
      END IF;
    END IF;
    PERFORM sourcing_require_operation_event(
      NEW.operation_event_id,NEW.request_id,NEW.decided_by,
      'sourcing.management_decision.record','sourcing:decision:record',
      NEW.sourcing_case_id,NEW.decision_reason
    );
  ELSE
    IF sourcing_current_status(NEW.sourcing_case_id)<>'pending_factory_change_verification'
      OR previous_decision.sourcing_decision_id IS NULL
      OR NEW.decision_version<>previous_decision.decision_version+1
      OR NEW.supersedes_decision_id<>previous_decision.sourcing_decision_id THEN
      RAISE EXCEPTION 'factory change decision must supersede the current decision'
        USING ERRCODE='23514';
    END IF;
    SELECT * INTO source_change
    FROM sourcing_factory_change_requests
    WHERE factory_change_request_id=NEW.source_change_request_id
      AND sourcing_case_id=NEW.sourcing_case_id
      AND from_decision_id=previous_decision.sourcing_decision_id;
    SELECT * INTO source_verification
    FROM sourcing_factory_change_decisions
    WHERE factory_change_request_id=NEW.source_change_request_id
      AND decision='approved'
      AND operation_event_id=NEW.operation_event_id;
    IF source_change.factory_change_request_id IS NULL
      OR source_verification.factory_change_decision_id IS NULL
      OR (NEW.supplier_id,NEW.supplier_code_snapshot,NEW.supplier_name_snapshot,
          NEW.unit_price,NEW.quantity,NEW.total_amount)
        IS DISTINCT FROM
         (source_change.proposed_supplier_id,source_change.proposed_supplier_code_snapshot,
          source_change.proposed_supplier_name_snapshot,source_change.proposed_unit_price,
          source_change.proposed_quantity,source_change.proposed_total_amount) THEN
      RAISE EXCEPTION 'approved factory change decision must match the immutable request'
        USING ERRCODE='55000';
    END IF;
    PERFORM sourcing_require_operation_event(
      NEW.operation_event_id,NEW.request_id,NEW.decided_by,
      'sourcing.factory_change.approved','sourcing:factory_change:verify',
      NEW.sourcing_case_id,NEW.decision_reason
    );
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION guard_sourcing_owner_decision_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  current_decision sourcing_decisions%ROWTYPE;
  required_action text;
BEGIN
  PERFORM 1 FROM sourcing_cases
  WHERE sourcing_case_id=NEW.sourcing_case_id FOR UPDATE;
  SELECT * INTO current_decision
  FROM sourcing_decisions
  WHERE sourcing_case_id=NEW.sourcing_case_id
  ORDER BY decision_version DESC
  LIMIT 1;
  IF sourcing_current_status(NEW.sourcing_case_id)<>'pending_owner_approval'
    OR current_decision.sourcing_decision_id IS NULL
    OR current_decision.source_type='factory_change'
    OR NEW.sourcing_decision_id<>current_decision.sourcing_decision_id THEN
    RAISE EXCEPTION 'owner decision must bind the current management decision'
      USING ERRCODE='23514';
  END IF;
  required_action := CASE NEW.decision
    WHEN 'approved' THEN 'sourcing.owner.approve'
    ELSE 'sourcing.owner.reject'
  END;
  PERFORM sourcing_require_operation_event(
    NEW.operation_event_id,NEW.request_id,NEW.decided_by,
    required_action,'sourcing:owner:approve',
    NEW.sourcing_case_id,NEW.decision_reason
  );
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION guard_sourcing_contract_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  current_decision sourcing_decisions%ROWTYPE;
BEGIN
  PERFORM 1 FROM sourcing_cases
  WHERE sourcing_case_id=NEW.sourcing_case_id FOR UPDATE;
  SELECT * INTO current_decision
  FROM sourcing_decisions
  WHERE sourcing_case_id=NEW.sourcing_case_id
  ORDER BY decision_version DESC
  LIMIT 1;
  IF sourcing_current_status(NEW.sourcing_case_id)<>'pending_contract'
    OR current_decision.sourcing_decision_id IS NULL
    OR NEW.sourcing_decision_id<>current_decision.sourcing_decision_id
    OR (
      current_decision.source_type<>'factory_change'
      AND NOT EXISTS (
        SELECT 1 FROM sourcing_owner_decisions owner_decision
        WHERE owner_decision.sourcing_decision_id=current_decision.sourcing_decision_id
          AND owner_decision.decision='approved'
      )
    ) THEN
    RAISE EXCEPTION 'contract must bind the current decision in pending contract state'
      USING ERRCODE='23514';
  END IF;
  PERFORM sourcing_require_operation_event(
    NEW.operation_event_id,NEW.request_id,NEW.recorded_by,
    'sourcing.contract.record','sourcing:contract:record',
    NEW.sourcing_case_id,NEW.execution_reason
  );
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION guard_sourcing_factory_change_request_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  source_case sourcing_cases%ROWTYPE;
  current_decision sourcing_decisions%ROWTYPE;
BEGIN
  SELECT * INTO source_case FROM sourcing_cases
  WHERE sourcing_case_id=NEW.sourcing_case_id FOR UPDATE;
  SELECT * INTO current_decision
  FROM sourcing_decisions
  WHERE sourcing_case_id=NEW.sourcing_case_id
  ORDER BY decision_version DESC
  LIMIT 1;
  IF sourcing_current_status(NEW.sourcing_case_id)<>'pending_finance_reconciliation'
    OR current_decision.sourcing_decision_id IS NULL
    OR NEW.from_decision_id<>current_decision.sourcing_decision_id
    OR NEW.proposed_supplier_id=current_decision.supplier_id
    OR NEW.proposed_quantity<>source_case.order_quantity
    OR NOT EXISTS (
      SELECT 1 FROM sourcing_contract_executions contract_row
      WHERE contract_row.sourcing_decision_id=current_decision.sourcing_decision_id
    ) THEN
    RAISE EXCEPTION 'factory change must replace the contracted current factory'
      USING ERRCODE='23514';
  END IF;
  PERFORM sourcing_require_active_factory(
    NEW.proposed_supplier_id,
    NEW.proposed_supplier_code_snapshot,
    NEW.proposed_supplier_name_snapshot
  );
  PERFORM sourcing_require_operation_event(
    NEW.operation_event_id,NEW.request_id,NEW.requested_by,
    'sourcing.factory_change.request','sourcing:factory_change:request',
    NEW.sourcing_case_id,NEW.change_reason
  );
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION guard_sourcing_factory_change_decision_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  source_request sourcing_factory_change_requests%ROWTYPE;
  required_action text;
BEGIN
  SELECT * INTO source_request
  FROM sourcing_factory_change_requests
  WHERE factory_change_request_id=NEW.factory_change_request_id;
  IF source_request.factory_change_request_id IS NULL THEN
    RAISE EXCEPTION 'factory change request does not exist'
      USING ERRCODE='23503';
  END IF;
  PERFORM 1 FROM sourcing_cases
  WHERE sourcing_case_id=source_request.sourcing_case_id FOR UPDATE;
  IF sourcing_current_status(source_request.sourcing_case_id)
    <>'pending_factory_change_verification' THEN
    RAISE EXCEPTION 'factory change is not pending verification'
      USING ERRCODE='23514';
  END IF;
  required_action := CASE NEW.decision
    WHEN 'approved' THEN 'sourcing.factory_change.approved'
    ELSE 'sourcing.factory_change.rejected'
  END;
  PERFORM sourcing_require_operation_event(
    NEW.operation_event_id,NEW.request_id,NEW.verified_by,
    required_action,'sourcing:factory_change:verify',
    source_request.sourcing_case_id,NEW.verification_reason
  );
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION guard_sourcing_reconciliation_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  source_decision sourcing_decisions%ROWTYPE;
  source_contract sourcing_contract_executions%ROWTYPE;
  previous_version integer;
  expected_differences text[];
  expected_action text;
BEGIN
  PERFORM 1 FROM sourcing_cases
  WHERE sourcing_case_id=NEW.sourcing_case_id FOR UPDATE;
  SELECT * INTO source_decision
  FROM sourcing_decisions
  WHERE sourcing_case_id=NEW.sourcing_case_id
  ORDER BY decision_version DESC
  LIMIT 1;
  SELECT * INTO source_contract
  FROM sourcing_contract_executions
  WHERE sourcing_contract_id=NEW.sourcing_contract_id
    AND sourcing_case_id=NEW.sourcing_case_id
    AND sourcing_decision_id=NEW.sourcing_decision_id;
  SELECT COALESCE(max(reconciliation_version),0) INTO previous_version
  FROM sourcing_finance_reconciliations
  WHERE sourcing_case_id=NEW.sourcing_case_id;

  IF sourcing_current_status(NEW.sourcing_case_id)<>'pending_finance_reconciliation'
    OR source_decision.sourcing_decision_id IS NULL
    OR NEW.sourcing_decision_id<>source_decision.sourcing_decision_id
    OR source_contract.sourcing_contract_id IS NULL
    OR NEW.reconciliation_version<>previous_version+1 THEN
    RAISE EXCEPTION 'finance reconciliation must bind the current contracted decision'
      USING ERRCODE='23514';
  END IF;

  expected_differences := ARRAY_REMOVE(ARRAY[
    CASE WHEN NEW.actual_supplier_id<>source_decision.supplier_id THEN 'supplier' END,
    CASE WHEN NEW.actual_unit_price<>source_decision.unit_price THEN 'unit_price' END,
    CASE WHEN NEW.actual_quantity<>source_decision.quantity THEN 'quantity' END,
    CASE WHEN NEW.actual_total_amount<>source_decision.total_amount THEN 'total_amount' END
  ]::text[],NULL);

  IF (cardinality(expected_differences)=0 AND (
      NEW.result<>'match' OR cardinality(NEW.difference_fields)<>0
    ))
    OR (cardinality(expected_differences)>0 AND (
      NEW.result<>'difference' OR NEW.difference_fields<>expected_differences
    )) THEN
    RAISE EXCEPTION 'finance reconciliation result must exactly match the four compared fields'
      USING ERRCODE='23514';
  END IF;

  expected_action := CASE NEW.result
    WHEN 'match' THEN 'sourcing.finance.matched'
    ELSE 'sourcing.finance.difference'
  END;
  PERFORM sourcing_require_operation_event(
    NEW.operation_event_id,NEW.request_id,NEW.reconciled_by,
    expected_action,'sourcing:finance:reconcile',
    NEW.sourcing_case_id,NEW.difference_reason
  );
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION guard_sourcing_transition_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  previous_transition sourcing_case_transitions%ROWTYPE;
  expected_from text;
  expected_to text;
  expected_event_action text;
  expected_capability text;
  supporting_fact_exists boolean := true;
BEGIN
  PERFORM 1 FROM sourcing_cases
  WHERE sourcing_case_id=NEW.sourcing_case_id FOR UPDATE;
  SELECT * INTO previous_transition
  FROM sourcing_case_transitions
  WHERE sourcing_case_id=NEW.sourcing_case_id
  ORDER BY sequence DESC
  LIMIT 1;

  IF previous_transition.sourcing_transition_id IS NULL THEN
    IF NEW.sequence<>1 OR NEW.from_status IS NOT NULL
      OR NEW.to_status<>'pending_ie_quote' OR NEW.business_action<>'created' THEN
      RAISE EXCEPTION 'first sourcing transition must create a pending IE quote case'
        USING ERRCODE='23514';
    END IF;
  ELSIF NEW.sequence<>previous_transition.sequence+1
    OR NEW.from_status IS DISTINCT FROM previous_transition.to_status THEN
    RAISE EXCEPTION 'sourcing transitions must be sequential from current state'
      USING ERRCODE='23514';
  END IF;

  SELECT rule.from_status,rule.to_status,rule.event_action,rule.capability
  INTO expected_from,expected_to,expected_event_action,expected_capability
  FROM (VALUES
    ('created',NULL::text,'pending_ie_quote','sourcing.case.create','sourcing:inquiry:create'),
    ('ie_price_quoted','pending_ie_quote','pending_management_decision','sourcing.ie_price.quote','sourcing:price:quote'),
    ('management_decision_recorded','pending_management_decision','pending_owner_approval','sourcing.management_decision.record','sourcing:decision:record'),
    ('owner_approved','pending_owner_approval','pending_contract','sourcing.owner.approve','sourcing:owner:approve'),
    ('owner_rejected','pending_owner_approval','pending_management_decision','sourcing.owner.reject','sourcing:owner:approve'),
    ('contract_recorded','pending_contract','pending_finance_reconciliation','sourcing.contract.record','sourcing:contract:record'),
    ('factory_change_requested','pending_finance_reconciliation','pending_factory_change_verification','sourcing.factory_change.request','sourcing:factory_change:request'),
    ('factory_change_approved','pending_factory_change_verification','pending_contract','sourcing.factory_change.approved','sourcing:factory_change:verify'),
    ('factory_change_rejected','pending_factory_change_verification','pending_finance_reconciliation','sourcing.factory_change.rejected','sourcing:factory_change:verify'),
    ('finance_matched','pending_finance_reconciliation','closed','sourcing.finance.matched','sourcing:finance:reconcile'),
    ('finance_difference','pending_finance_reconciliation','pending_exception_verification','sourcing.finance.difference','sourcing:finance:reconcile'),
    ('exception_reopened_for_contract','pending_exception_verification','pending_contract','sourcing.exception.reopen_contract','sourcing:exception:verify'),
    ('exception_reopened_for_reconciliation','pending_exception_verification','pending_finance_reconciliation','sourcing.exception.reopen_reconciliation','sourcing:exception:verify'),
    ('exception_closed','pending_exception_verification','closed','sourcing.exception.close','sourcing:exception:verify')
  ) AS rule(action,from_status,to_status,event_action,capability)
  WHERE rule.action=NEW.business_action;

  IF expected_event_action IS NULL
    OR NEW.from_status IS DISTINCT FROM expected_from
    OR NEW.to_status<>expected_to THEN
    RAISE EXCEPTION 'sourcing state transition is not allowed'
      USING ERRCODE='23514';
  END IF;

  supporting_fact_exists := CASE NEW.business_action
    WHEN 'created' THEN EXISTS(
      SELECT 1 FROM sourcing_cases source_case
      WHERE source_case.sourcing_case_id=NEW.sourcing_case_id
        AND source_case.operation_event_id=NEW.operation_event_id
    )
    WHEN 'ie_price_quoted' THEN EXISTS(
      SELECT 1 FROM sourcing_ie_quotes quote_row
      WHERE quote_row.sourcing_case_id=NEW.sourcing_case_id
        AND quote_row.operation_event_id=NEW.operation_event_id
    )
    WHEN 'management_decision_recorded' THEN EXISTS(
      SELECT 1 FROM sourcing_decisions decision_row
      WHERE decision_row.sourcing_case_id=NEW.sourcing_case_id
        AND decision_row.operation_event_id=NEW.operation_event_id
        AND decision_row.source_type IN ('initial','management_revision')
    )
    WHEN 'owner_approved' THEN EXISTS(
      SELECT 1 FROM sourcing_owner_decisions owner_decision
      WHERE owner_decision.sourcing_case_id=NEW.sourcing_case_id
        AND owner_decision.operation_event_id=NEW.operation_event_id
        AND owner_decision.decision='approved'
    )
    WHEN 'owner_rejected' THEN EXISTS(
      SELECT 1 FROM sourcing_owner_decisions owner_decision
      WHERE owner_decision.sourcing_case_id=NEW.sourcing_case_id
        AND owner_decision.operation_event_id=NEW.operation_event_id
        AND owner_decision.decision='rejected'
    )
    WHEN 'contract_recorded' THEN EXISTS(
      SELECT 1 FROM sourcing_contract_executions contract_row
      WHERE contract_row.sourcing_case_id=NEW.sourcing_case_id
        AND contract_row.operation_event_id=NEW.operation_event_id
    )
    WHEN 'factory_change_requested' THEN EXISTS(
      SELECT 1 FROM sourcing_factory_change_requests request_row
      WHERE request_row.sourcing_case_id=NEW.sourcing_case_id
        AND request_row.operation_event_id=NEW.operation_event_id
    )
    WHEN 'factory_change_approved' THEN EXISTS(
      SELECT 1
      FROM sourcing_factory_change_decisions verification
      JOIN sourcing_factory_change_requests request_row
        ON request_row.factory_change_request_id=verification.factory_change_request_id
      JOIN sourcing_decisions decision_row
        ON decision_row.source_change_request_id=request_row.factory_change_request_id
       AND decision_row.operation_event_id=verification.operation_event_id
      WHERE request_row.sourcing_case_id=NEW.sourcing_case_id
        AND verification.operation_event_id=NEW.operation_event_id
        AND verification.decision='approved'
    )
    WHEN 'factory_change_rejected' THEN EXISTS(
      SELECT 1
      FROM sourcing_factory_change_decisions verification
      JOIN sourcing_factory_change_requests request_row
        ON request_row.factory_change_request_id=verification.factory_change_request_id
      WHERE request_row.sourcing_case_id=NEW.sourcing_case_id
        AND verification.operation_event_id=NEW.operation_event_id
        AND verification.decision='rejected'
    )
    WHEN 'finance_matched' THEN EXISTS(
      SELECT 1 FROM sourcing_finance_reconciliations reconciliation
      WHERE reconciliation.sourcing_case_id=NEW.sourcing_case_id
        AND reconciliation.operation_event_id=NEW.operation_event_id
        AND reconciliation.result='match'
    )
    WHEN 'finance_difference' THEN EXISTS(
      SELECT 1 FROM sourcing_finance_reconciliations reconciliation
      WHERE reconciliation.sourcing_case_id=NEW.sourcing_case_id
        AND reconciliation.operation_event_id=NEW.operation_event_id
        AND reconciliation.result='difference'
    )
    ELSE true
  END;

  IF supporting_fact_exists IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'sourcing transition requires its matching immutable business fact'
      USING ERRCODE='55000';
  END IF;

  PERFORM sourcing_require_operation_event(
    NEW.operation_event_id,NEW.request_id,NEW.actor_id,
    expected_event_action,expected_capability,
    NEW.sourcing_case_id,NEW.transition_reason
  );
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION require_sourcing_case_initial_transition()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM sourcing_case_transitions transition_row
    WHERE transition_row.sourcing_case_id=NEW.sourcing_case_id
      AND transition_row.sequence=1
      AND transition_row.business_action='created'
      AND transition_row.to_status='pending_ie_quote'
      AND transition_row.operation_event_id=NEW.operation_event_id
  ) THEN
    RAISE EXCEPTION 'sourcing case requires its audited initial transition'
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER sourcing_cases_guard_insert
  BEFORE INSERT ON sourcing_cases FOR EACH ROW
  EXECUTE FUNCTION guard_sourcing_case_insert();
CREATE TRIGGER sourcing_ie_quotes_guard_insert
  BEFORE INSERT ON sourcing_ie_quotes FOR EACH ROW
  EXECUTE FUNCTION guard_sourcing_ie_quote_insert();
CREATE TRIGGER sourcing_decisions_guard_insert
  BEFORE INSERT ON sourcing_decisions FOR EACH ROW
  EXECUTE FUNCTION guard_sourcing_decision_insert();
CREATE TRIGGER sourcing_owner_decisions_guard_insert
  BEFORE INSERT ON sourcing_owner_decisions FOR EACH ROW
  EXECUTE FUNCTION guard_sourcing_owner_decision_insert();
CREATE TRIGGER sourcing_contracts_guard_insert
  BEFORE INSERT ON sourcing_contract_executions FOR EACH ROW
  EXECUTE FUNCTION guard_sourcing_contract_insert();
CREATE TRIGGER sourcing_factory_change_requests_guard_insert
  BEFORE INSERT ON sourcing_factory_change_requests FOR EACH ROW
  EXECUTE FUNCTION guard_sourcing_factory_change_request_insert();
CREATE TRIGGER sourcing_factory_change_decisions_guard_insert
  BEFORE INSERT ON sourcing_factory_change_decisions FOR EACH ROW
  EXECUTE FUNCTION guard_sourcing_factory_change_decision_insert();
CREATE TRIGGER sourcing_reconciliations_guard_insert
  BEFORE INSERT ON sourcing_finance_reconciliations FOR EACH ROW
  EXECUTE FUNCTION guard_sourcing_reconciliation_insert();
CREATE TRIGGER sourcing_transitions_guard_insert
  BEFORE INSERT ON sourcing_case_transitions FOR EACH ROW
  EXECUTE FUNCTION guard_sourcing_transition_insert();
CREATE CONSTRAINT TRIGGER sourcing_cases_require_initial_transition
  AFTER INSERT ON sourcing_cases
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION require_sourcing_case_initial_transition();

CREATE TRIGGER sourcing_cases_no_update BEFORE UPDATE ON sourcing_cases
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER sourcing_cases_no_delete BEFORE DELETE ON sourcing_cases
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER sourcing_cases_no_truncate BEFORE TRUNCATE ON sourcing_cases
  FOR EACH STATEMENT EXECUTE FUNCTION reject_operation_event_mutation();

CREATE TRIGGER sourcing_ie_quotes_no_update BEFORE UPDATE ON sourcing_ie_quotes
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER sourcing_ie_quotes_no_delete BEFORE DELETE ON sourcing_ie_quotes
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER sourcing_ie_quotes_no_truncate BEFORE TRUNCATE ON sourcing_ie_quotes
  FOR EACH STATEMENT EXECUTE FUNCTION reject_operation_event_mutation();

CREATE TRIGGER sourcing_decisions_no_update BEFORE UPDATE ON sourcing_decisions
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER sourcing_decisions_no_delete BEFORE DELETE ON sourcing_decisions
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER sourcing_decisions_no_truncate BEFORE TRUNCATE ON sourcing_decisions
  FOR EACH STATEMENT EXECUTE FUNCTION reject_operation_event_mutation();

CREATE TRIGGER sourcing_owner_decisions_no_update BEFORE UPDATE ON sourcing_owner_decisions
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER sourcing_owner_decisions_no_delete BEFORE DELETE ON sourcing_owner_decisions
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER sourcing_owner_decisions_no_truncate BEFORE TRUNCATE ON sourcing_owner_decisions
  FOR EACH STATEMENT EXECUTE FUNCTION reject_operation_event_mutation();

CREATE TRIGGER sourcing_contracts_no_update BEFORE UPDATE ON sourcing_contract_executions
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER sourcing_contracts_no_delete BEFORE DELETE ON sourcing_contract_executions
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER sourcing_contracts_no_truncate BEFORE TRUNCATE ON sourcing_contract_executions
  FOR EACH STATEMENT EXECUTE FUNCTION reject_operation_event_mutation();

CREATE TRIGGER sourcing_factory_change_requests_no_update BEFORE UPDATE ON sourcing_factory_change_requests
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER sourcing_factory_change_requests_no_delete BEFORE DELETE ON sourcing_factory_change_requests
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER sourcing_factory_change_requests_no_truncate BEFORE TRUNCATE ON sourcing_factory_change_requests
  FOR EACH STATEMENT EXECUTE FUNCTION reject_operation_event_mutation();

CREATE TRIGGER sourcing_factory_change_decisions_no_update BEFORE UPDATE ON sourcing_factory_change_decisions
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER sourcing_factory_change_decisions_no_delete BEFORE DELETE ON sourcing_factory_change_decisions
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER sourcing_factory_change_decisions_no_truncate BEFORE TRUNCATE ON sourcing_factory_change_decisions
  FOR EACH STATEMENT EXECUTE FUNCTION reject_operation_event_mutation();

CREATE TRIGGER sourcing_reconciliations_no_update BEFORE UPDATE ON sourcing_finance_reconciliations
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER sourcing_reconciliations_no_delete BEFORE DELETE ON sourcing_finance_reconciliations
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER sourcing_reconciliations_no_truncate BEFORE TRUNCATE ON sourcing_finance_reconciliations
  FOR EACH STATEMENT EXECUTE FUNCTION reject_operation_event_mutation();

CREATE TRIGGER sourcing_transitions_no_update BEFORE UPDATE ON sourcing_case_transitions
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER sourcing_transitions_no_delete BEFORE DELETE ON sourcing_case_transitions
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER sourcing_transitions_no_truncate BEFORE TRUNCATE ON sourcing_case_transitions
  FOR EACH STATEMENT EXECUTE FUNCTION reject_operation_event_mutation();
