-- Factory allocation facts share the original production identity and quantity/report ledgers.
CREATE TABLE sourcing_production_factory_transfers (
 factory_decision_id uuid PRIMARY KEY REFERENCES sourcing_decisions(sourcing_decision_id),
 production_order_id uuid NOT NULL REFERENCES sourcing_production_orders(production_order_id),
 from_decision_id uuid NOT NULL REFERENCES sourcing_decisions(sourcing_decision_id),
 operation_event_id uuid NOT NULL UNIQUE REFERENCES operation_events(event_id),
 effective_at timestamptz NOT NULL DEFAULT statement_timestamp(),
 UNIQUE(production_order_id,from_decision_id),
 UNIQUE(production_order_id,factory_decision_id)
);
CREATE TABLE sourcing_production_factory_transfer_lines (
 factory_decision_id uuid NOT NULL REFERENCES sourcing_production_factory_transfers(factory_decision_id),
 position integer NOT NULL,
 retained_quantity integer NOT NULL CHECK(retained_quantity>=0),
 transferred_quantity integer NOT NULL CHECK(transferred_quantity>=0),
 PRIMARY KEY(factory_decision_id,position)
);
ALTER TABLE sourcing_production_reports ADD COLUMN factory_decision_id uuid REFERENCES sourcing_production_factory_transfers(factory_decision_id);
ALTER TABLE sourcing_production_transitions ADD COLUMN factory_decision_id uuid REFERENCES sourcing_production_factory_transfers(factory_decision_id);
ALTER TABLE sourcing_production_shipments ADD COLUMN factory_decision_id uuid REFERENCES sourcing_production_factory_transfers(factory_decision_id);
ALTER TABLE sourcing_production_progress_snapshots ADD COLUMN factory_decision_id uuid REFERENCES sourcing_production_factory_transfers(factory_decision_id);
ALTER TABLE sourcing_production_receipt_links ADD COLUMN factory_decision_id uuid REFERENCES sourcing_production_factory_transfers(factory_decision_id);
ALTER TABLE sourcing_finance_reconciliations ADD COLUMN factory_decision_id uuid REFERENCES sourcing_decisions(sourcing_decision_id);
-- Future facts use their write statement time after serialization, never a transaction start before a waited-on transfer.
ALTER TABLE sourcing_production_reports ALTER COLUMN created_at SET DEFAULT statement_timestamp();
ALTER TABLE sourcing_production_transitions ALTER COLUMN created_at SET DEFAULT statement_timestamp();
ALTER TABLE sourcing_production_shipments ALTER COLUMN created_at SET DEFAULT statement_timestamp();
CREATE FUNCTION guard_sourcing_factory_finance_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM sourcing_finance_reconciliations reconciliation
   WHERE reconciliation.sourcing_case_id=NEW.sourcing_case_id AND reconciliation.factory_decision_id IS NOT NULL
   AND (reconciliation.operation_event_id=NEW.operation_event_id OR
     (NEW.business_action IN ('exception_closed','exception_reopened_for_reconciliation')
      AND reconciliation.reconciliation_version=(SELECT (event.before_state->>'reconciliationVersion')::integer FROM operation_events event WHERE event_id=NEW.operation_event_id))))
 THEN RAISE EXCEPTION 'factory settlements cannot drive the current order workflow' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER sourcing_factory_finance_transition_guard BEFORE INSERT ON sourcing_case_transitions
 FOR EACH ROW EXECUTE FUNCTION guard_sourcing_factory_finance_transition();
CREATE OR REPLACE VIEW effective_sourcing_production_reports AS
 SELECT DISTINCT ON(root_report_id) * FROM sourcing_production_reports ORDER BY root_report_id,revision DESC;
DO $$ DECLARE constraint_name text; BEGIN
 SELECT conname INTO STRICT constraint_name FROM pg_constraint
 WHERE conrelid='sourcing_production_transitions'::regclass AND contype='u'
 AND pg_get_constraintdef(oid)='UNIQUE (production_order_id, sequence)';
 EXECUTE format('ALTER TABLE sourcing_production_transitions DROP CONSTRAINT %I',constraint_name);
END $$;
ALTER TABLE sourcing_production_transitions ADD CONSTRAINT sourcing_production_factory_sequence
 UNIQUE NULLS NOT DISTINCT(production_order_id,factory_decision_id,sequence);
-- A receipt references the actual factory shipment, not an arbitrary shipment of its parent.
ALTER TABLE sourcing_production_receipt_links DROP CONSTRAINT sourcing_production_receipt_links_production_order_id_fkey;
ALTER TABLE sourcing_production_shipments DROP CONSTRAINT sourcing_production_shipments_pkey;
ALTER TABLE sourcing_production_progress_snapshots DROP CONSTRAINT sourcing_production_progress_snapshots_pkey;
ALTER TABLE sourcing_production_shipments ADD COLUMN factory_execution_key uuid GENERATED ALWAYS AS (COALESCE(factory_decision_id,production_order_id)) STORED;
ALTER TABLE sourcing_production_progress_snapshots ADD COLUMN factory_execution_key uuid GENERATED ALWAYS AS (COALESCE(factory_decision_id,production_order_id)) STORED;
ALTER TABLE sourcing_production_receipt_links ADD COLUMN factory_execution_key uuid GENERATED ALWAYS AS (COALESCE(factory_decision_id,production_order_id)) STORED;
ALTER TABLE sourcing_production_shipments ADD PRIMARY KEY(production_order_id,factory_execution_key);
ALTER TABLE sourcing_production_progress_snapshots ADD PRIMARY KEY(production_order_id,factory_execution_key);
ALTER TABLE sourcing_production_receipt_links ADD CONSTRAINT sourcing_production_receipt_factory_shipment
 FOREIGN KEY(production_order_id,factory_execution_key) REFERENCES sourcing_production_shipments(production_order_id,factory_execution_key);

CREATE FUNCTION sourcing_factory_execution_lines(order_id uuid,decision_id uuid,at_time timestamptz DEFAULT NULL)
RETURNS TABLE("position" integer,quantity integer,completed_quantity integer) LANGUAGE sql STABLE AS $$
 SELECT line.position,
  (COALESCE(incoming.transferred_quantity,line.quantity)-COALESCE(outgoing.transferred_quantity,0))::integer AS quantity,
  COALESCE(reports.quantity,0)::integer AS completed_quantity
 FROM sourcing_production_orders production JOIN sourcing_production_lines line USING(production_order_id)
 LEFT JOIN sourcing_production_factory_transfers transfer ON transfer.factory_decision_id=decision_id
   AND transfer.production_order_id=production.production_order_id AND (at_time IS NULL OR transfer.effective_at<=at_time)
 LEFT JOIN sourcing_production_factory_transfer_lines incoming ON incoming.factory_decision_id=transfer.factory_decision_id AND incoming.position=line.position
 LEFT JOIN sourcing_production_factory_transfers later ON later.production_order_id=production.production_order_id
   AND later.from_decision_id=decision_id AND (at_time IS NULL OR later.effective_at<=at_time)
 LEFT JOIN sourcing_production_factory_transfer_lines outgoing ON outgoing.factory_decision_id=later.factory_decision_id AND outgoing.position=line.position
 LEFT JOIN LATERAL (SELECT sum(effective.quantity) AS quantity FROM (
   SELECT DISTINCT ON(root_report_id) quantity FROM sourcing_production_reports report
   WHERE report.production_order_id=production.production_order_id AND report.position=line.position
    AND COALESCE(report.factory_decision_id,production.sourcing_decision_id)=decision_id
    AND (at_time IS NULL OR report.created_at<=at_time) ORDER BY root_report_id,revision DESC) effective) reports ON true
 WHERE production.production_order_id=order_id AND (production.sourcing_decision_id=decision_id OR transfer.factory_decision_id IS NOT NULL);
$$;
CREATE FUNCTION sourcing_factory_remaining_lines(case_id uuid,decision_id uuid)
RETURNS TABLE("position" integer,planned_quantity integer,completed_quantity integer,quantity integer) LANGUAGE sql STABLE AS $$
 SELECT line.position,line.quantity,line.completed_quantity,GREATEST(line.quantity-line.completed_quantity,0)::integer
 FROM sourcing_production_orders production
 CROSS JOIN LATERAL sourcing_factory_execution_lines(production.production_order_id,decision_id) line
 WHERE production.sourcing_case_id=case_id
 UNION ALL
 SELECT line.position,line.quantity,0,line.quantity FROM current_sourcing_case_lines line
 WHERE line.sourcing_case_id=case_id AND NOT EXISTS(SELECT 1 FROM sourcing_production_orders WHERE sourcing_case_id=case_id);
$$;
CREATE FUNCTION sourcing_production_factory_reporter_allowed(user_id_in uuid,order_id_in uuid,decision_id_in uuid DEFAULT NULL)
RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM current_sourcing_production_reporting_scopes scope
 JOIN sourcing_production_orders production ON production.production_order_id=order_id_in
 LEFT JOIN sourcing_production_factory_transfers transfer ON transfer.factory_decision_id=decision_id_in AND transfer.production_order_id=order_id_in
 LEFT JOIN sourcing_decisions decision ON decision.sourcing_decision_id=transfer.factory_decision_id
 WHERE scope.user_id=user_id_in AND scope.active AND (decision_id_in IS NULL OR transfer.factory_decision_id IS NOT NULL)
 AND ((scope.scope_type='supplier' AND scope.scope_id=COALESCE(decision.supplier_id,production.supplier_id))
 OR (scope.scope_type='order' AND scope.scope_id=production.production_order_id)));
$$;
CREATE FUNCTION guard_sourcing_factory_execution() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE production sourcing_production_orders%ROWTYPE; decision sourcing_decisions%ROWTYPE; audit operation_events%ROWTYPE;
BEGIN
 SELECT * INTO production FROM sourcing_production_orders WHERE production_order_id=NEW.production_order_id FOR UPDATE;
 SELECT * INTO decision FROM sourcing_decisions WHERE sourcing_decision_id=NEW.factory_decision_id;
 SELECT * INTO audit FROM operation_events WHERE event_id=NEW.operation_event_id;
 IF decision.sourcing_case_id IS DISTINCT FROM production.sourcing_case_id OR decision.source_type IS DISTINCT FROM 'factory_change'
 OR decision.supersedes_decision_id IS DISTINCT FROM NEW.from_decision_id OR decision.operation_event_id IS DISTINCT FROM NEW.operation_event_id
 OR audit.action IS DISTINCT FROM 'sourcing.factory_change.effective' OR audit.entity_type IS DISTINCT FROM 'sourcing_case'
 OR audit.entity_id IS DISTINCT FROM production.sourcing_case_id::text
 OR NEW.effective_at IS DISTINCT FROM statement_timestamp()
 OR NEW.from_decision_id IS DISTINCT FROM COALESCE((SELECT factory_decision_id FROM sourcing_production_factory_transfers
   WHERE production_order_id=NEW.production_order_id ORDER BY effective_at DESC LIMIT 1),production.sourcing_decision_id)
 OR NOT EXISTS(SELECT 1 FROM sourcing_approval_snapshots WHERE sourcing_decision_id=NEW.factory_decision_id)
 THEN RAISE EXCEPTION 'factory execution requires its actual approved transfer and active production source' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER sourcing_factory_execution_guard BEFORE INSERT ON sourcing_production_factory_transfers FOR EACH ROW EXECUTE FUNCTION guard_sourcing_factory_execution();
CREATE FUNCTION guard_sourcing_factory_transfer_line() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE transfer sourcing_production_factory_transfers%ROWTYPE; expected record;
BEGIN
 SELECT * INTO transfer FROM sourcing_production_factory_transfers WHERE factory_decision_id=NEW.factory_decision_id;
 PERFORM 1 FROM sourcing_production_orders WHERE production_order_id=transfer.production_order_id FOR UPDATE;
 SELECT line.* INTO expected FROM sourcing_factory_execution_lines(transfer.production_order_id,transfer.from_decision_id) line WHERE position=NEW.position;
 -- The just inserted header has no outgoing line yet, so the source plan still includes this portion.
 IF expected.position IS NULL OR NEW.retained_quantity IS DISTINCT FROM expected.completed_quantity
 OR NEW.retained_quantity+NEW.transferred_quantity IS DISTINCT FROM expected.quantity
 OR NOT (NEW.transferred_quantity=0 OR EXISTS(SELECT 1 FROM sourcing_decision_lines line
   WHERE sourcing_decision_id=NEW.factory_decision_id AND position=NEW.position AND quantity=NEW.transferred_quantity))
 THEN RAISE EXCEPTION 'factory allocation must preserve completed quantities by stable source position' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER sourcing_factory_transfer_line_guard BEFORE INSERT ON sourcing_production_factory_transfer_lines FOR EACH ROW EXECUTE FUNCTION guard_sourcing_factory_transfer_line();
CREATE FUNCTION guard_sourcing_factory_allocation_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE transfer sourcing_production_factory_transfers%ROWTYPE;
BEGIN
 SELECT * INTO transfer FROM sourcing_production_factory_transfers WHERE factory_decision_id=NEW.factory_decision_id;
 IF (SELECT count(*) FROM sourcing_production_factory_transfer_lines WHERE factory_decision_id=transfer.factory_decision_id)
   IS DISTINCT FROM (SELECT count(*) FROM sourcing_production_lines WHERE production_order_id=transfer.production_order_id)
 OR (SELECT sum(transferred_quantity) FROM sourcing_production_factory_transfer_lines WHERE factory_decision_id=transfer.factory_decision_id)
   IS DISTINCT FROM (SELECT quantity FROM sourcing_decisions WHERE sourcing_decision_id=transfer.factory_decision_id)
 THEN RAISE EXCEPTION 'factory allocation must cover the complete original style/color identity set' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER sourcing_factory_allocation_complete AFTER INSERT ON sourcing_production_factory_transfers
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION guard_sourcing_factory_allocation_complete();
DO $$ DECLARE target text; BEGIN
 FOREACH target IN ARRAY ARRAY['sourcing_production_factory_transfers','sourcing_production_factory_transfer_lines'] LOOP
 EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation()',target||'_immutable',target);
 EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION reject_operation_event_mutation()',target||'_no_truncate',target);
 END LOOP;
END $$;
CREATE OR REPLACE FUNCTION guard_sourcing_factory_change_request_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  source_case sourcing_cases%ROWTYPE;
  current_decision sourcing_decisions%ROWTYPE;
  expected_action text;
  expected_capability text;
BEGIN
  SELECT * INTO source_case FROM sourcing_cases
  WHERE sourcing_case_id=NEW.sourcing_case_id FOR UPDATE;
  SELECT * INTO current_decision
  FROM sourcing_decisions
  WHERE sourcing_case_id=NEW.sourcing_case_id
  ORDER BY decision_version DESC LIMIT 1;
  expected_action := CASE
    WHEN NEW.initiator_role='owner_group'
      OR (NEW.initiator_role='production_management' AND NOT NEW.requires_owner_approval)
      THEN 'sourcing.factory_change.effective'
    ELSE 'sourcing.factory_change.request'
  END;
  expected_capability := CASE NEW.initiator_role
    WHEN 'order_merchandiser' THEN 'sourcing:factory_change:request'
    WHEN 'production_management' THEN 'sourcing:decision:record'
    ELSE 'sourcing:owner:approve'
  END;
  IF current_decision.sourcing_decision_id IS NULL
    OR NEW.from_decision_id<>current_decision.sourcing_decision_id
    OR NEW.proposed_supplier_id=current_decision.supplier_id
    OR NEW.proposed_quantity IS DISTINCT FROM (SELECT sum(quantity) FROM sourcing_factory_remaining_lines(NEW.sourcing_case_id,NEW.from_decision_id))
    OR NEW.proposed_total_amount IS DISTINCT FROM (SELECT sum(round(NEW.proposed_unit_price*quantity,2)) FROM sourcing_factory_remaining_lines(NEW.sourcing_case_id,NEW.from_decision_id))
    OR NEW.requires_owner_approval<>(NEW.proposed_unit_price>current_decision.unit_price)
    OR EXISTS (
      SELECT 1
      FROM sourcing_factory_change_requests existing
      WHERE existing.sourcing_case_id=NEW.sourcing_case_id
        AND NOT EXISTS (
          SELECT 1 FROM sourcing_decisions effective
          WHERE effective.source_change_request_id=existing.factory_change_request_id
        )
        AND NOT EXISTS (
          SELECT 1 FROM sourcing_factory_change_decisions rejected
          WHERE rejected.factory_change_request_id=existing.factory_change_request_id
            AND rejected.decision='rejected'
        )
    ) THEN
    RAISE EXCEPTION 'factory change must replace the current effective decision'
      USING ERRCODE='23514';
  END IF;
  PERFORM sourcing_require_active_factory(
    NEW.proposed_supplier_id,
    NEW.proposed_supplier_code_snapshot,
    NEW.proposed_supplier_name_snapshot
  );
  PERFORM sourcing_require_operation_event(
    NEW.operation_event_id,NEW.request_id,NEW.requested_by,
    expected_action,expected_capability,
    NEW.sourcing_case_id,NEW.change_reason
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
  PERFORM 1 FROM sourcing_cases WHERE sourcing_case_id=NEW.sourcing_case_id FOR UPDATE;
  SELECT * INTO source_case FROM sourcing_case_facts_at(NEW.sourcing_case_id);
  IF source_case.sourcing_case_id IS NULL OR NEW.quantity IS DISTINCT FROM (CASE WHEN NEW.source_type='factory_change' THEN (SELECT sum(quantity) FROM sourcing_factory_remaining_lines(NEW.sourcing_case_id,NEW.supersedes_decision_id)) ELSE source_case.order_quantity END) THEN
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
        OR (previous_owner_decision.sourcing_owner_decision_id IS NULL AND NOT EXISTS(
          SELECT 1 FROM sourcing_case_corrections correction JOIN sourcing_case_transitions transition
            ON transition.operation_event_id=correction.operation_event_id
          WHERE correction.sourcing_case_id=NEW.sourcing_case_id
            AND correction.corrected_at>=previous_decision.decided_at
            AND correction.corrected_at<=current_quote.quoted_at))
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
    IF previous_decision.sourcing_decision_id IS NULL
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
      OR (
        (source_change.requires_owner_approval OR source_change.initiator_role='owner_group')
        AND source_verification.decision_role<>'owner_group'
      )
      OR (
        NOT source_change.requires_owner_approval
        AND source_change.initiator_role<>'owner_group'
        AND source_verification.decision_role<>'production_management'
      )
      OR (NEW.supplier_id,NEW.supplier_code_snapshot,NEW.supplier_name_snapshot,
          NEW.unit_price,NEW.quantity,NEW.total_amount)
        IS DISTINCT FROM
         (source_change.proposed_supplier_id,source_change.proposed_supplier_code_snapshot,
          source_change.proposed_supplier_name_snapshot,source_change.proposed_unit_price,
          (SELECT sum(quantity) FROM sourcing_factory_remaining_lines(NEW.sourcing_case_id,NEW.supersedes_decision_id)),
          (SELECT sum(round(NEW.unit_price*quantity,2)) FROM sourcing_factory_remaining_lines(NEW.sourcing_case_id,NEW.supersedes_decision_id))) THEN
      RAISE EXCEPTION 'effective factory change must match its approved immutable request'
        USING ERRCODE='55000';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM operation_events event_row
      WHERE event_row.event_id=NEW.operation_event_id
        AND event_row.request_id=NEW.request_id
        AND event_row.actor_id=NEW.decided_by
        AND event_row.action='sourcing.factory_change.effective'
        AND event_row.authorization_capability IN (
          'sourcing:decision:record','sourcing:factory_change:verify','sourcing:owner:approve'
        )
        AND event_row.entity_type='sourcing_case'
        AND event_row.entity_id=NEW.sourcing_case_id::text
        AND event_row.reason IS NOT DISTINCT FROM NEW.decision_reason
    ) THEN
      RAISE EXCEPTION 'factory change effect requires its authorized operation event'
        USING ERRCODE='55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE OR REPLACE FUNCTION guard_sourcing_production_report() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE prior sourcing_production_reports%ROWTYPE; current_status text; finished_on date; total bigint; limit_quantity integer;
 audit operation_events%ROWTYPE; is_root boolean;
BEGIN
 -- Use the same case, user, production lock order as factory approvals and API writes.
 PERFORM 1 FROM sourcing_cases WHERE sourcing_case_id=(SELECT sourcing_case_id FROM sourcing_production_orders WHERE production_order_id=NEW.production_order_id) FOR UPDATE;
 PERFORM 1 FROM app_users WHERE id=NEW.actor_id FOR SHARE;
 PERFORM 1 FROM sourcing_production_orders WHERE production_order_id=NEW.production_order_id FOR UPDATE;
 SELECT * INTO audit FROM operation_events WHERE event_id=NEW.operation_event_id;
 is_root := COALESCE(audit.actor_roles @> ARRAY['root_superuser']::text[],false);
 SELECT status,business_date INTO current_status,finished_on FROM sourcing_production_transitions
 WHERE production_order_id=NEW.production_order_id AND factory_decision_id IS NOT DISTINCT FROM NEW.factory_decision_id ORDER BY sequence DESC LIMIT 1;
 IF NEW.business_date>(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date
 OR NOT EXISTS(SELECT 1 FROM sourcing_production_transitions dispatch WHERE dispatch.production_order_id=NEW.production_order_id
   AND dispatch.factory_decision_id IS NOT DISTINCT FROM NEW.factory_decision_id AND dispatch.sequence=1 AND dispatch.business_date<=NEW.business_date)
 OR audit.after_state->>'factoryDecisionId' IS DISTINCT FROM NEW.factory_decision_id::text
 OR audit.actor_id IS DISTINCT FROM NEW.actor_id OR audit.entity_id IS DISTINCT FROM NEW.report_id::text
 OR audit.entity_type IS DISTINCT FROM 'sourcing_production_report'
 OR audit.after_state->>'productionOrderId' IS DISTINCT FROM NEW.production_order_id::text
 OR audit.after_state->>'rootReportId' IS DISTINCT FROM NEW.root_report_id::text
 OR (audit.after_state->>'revision')::integer IS DISTINCT FROM NEW.revision
 OR (audit.after_state->>'position')::integer IS DISTINCT FROM NEW.position
 OR (audit.after_state->>'businessDate')::date IS DISTINCT FROM NEW.business_date
 OR (audit.after_state->>'quantity')::integer IS DISTINCT FROM NEW.quantity
 OR NEW.actor_name IS DISTINCT FROM (SELECT display_name FROM app_users WHERE id=NEW.actor_id)
 OR (NEW.revision=1 AND (audit.action IS DISTINCT FROM 'sourcing.production.report' OR current_status<>'in_production'))
 OR (NEW.revision>1 AND (NOT is_root OR audit.action IS DISTINCT FROM 'sourcing.production.correct' OR audit.reason IS DISTINCT FROM NEW.reason))
 OR (NOT is_root AND (audit.authorization_capability IS DISTINCT FROM 'production-reporting'
   OR NOT (audit.actor_roles @> ARRAY['production_reporter']::text[])
   OR NOT sourcing_production_factory_reporter_allowed(NEW.actor_id,NEW.production_order_id,NEW.factory_decision_id)))
 THEN RAISE EXCEPTION 'invalid production report authorization or date/state' USING ERRCODE='55000'; END IF;
 IF NEW.revision>1 THEN
   SELECT * INTO prior FROM effective_sourcing_production_reports WHERE root_report_id=NEW.root_report_id;
   IF prior.report_id IS NULL OR prior.revision+1<>NEW.revision OR prior.production_order_id<>NEW.production_order_id
     OR prior.factory_decision_id IS DISTINCT FROM NEW.factory_decision_id OR prior.position<>NEW.position OR (current_status<>'in_production' AND NEW.business_date>
       (SELECT business_date FROM sourcing_production_transitions WHERE production_order_id=NEW.production_order_id AND factory_decision_id IS NOT DISTINCT FROM NEW.factory_decision_id AND status='production_completed'))
   THEN RAISE EXCEPTION 'correction must reference latest original report within completion date' USING ERRCODE='55000'; END IF;
 END IF;
 SELECT COALESCE(sum(quantity),0) INTO total FROM effective_sourcing_production_reports
 WHERE production_order_id=NEW.production_order_id AND position=NEW.position AND factory_decision_id IS NOT DISTINCT FROM NEW.factory_decision_id;
 SELECT line.quantity INTO limit_quantity FROM sourcing_production_orders production
 CROSS JOIN LATERAL sourcing_factory_execution_lines(production.production_order_id,COALESCE(NEW.factory_decision_id,production.sourcing_decision_id)) line
 WHERE production.production_order_id=NEW.production_order_id AND line.position=NEW.position;
 IF limit_quantity IS NULL THEN RAISE EXCEPTION 'unknown factory execution line' USING ERRCODE='23514'; END IF;
 IF total-COALESCE(prior.quantity,0)+NEW.quantity>limit_quantity THEN
   RAISE EXCEPTION 'reported quantity exceeds approved line quantity' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
CREATE OR REPLACE FUNCTION guard_sourcing_production_execution() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE audit operation_events%ROWTYPE;
BEGIN
 IF NEW.sequence=1 THEN RETURN NEW; END IF;
 PERFORM 1 FROM app_users WHERE id=NEW.actor_id FOR SHARE;
 PERFORM 1 FROM sourcing_production_orders WHERE production_order_id=NEW.production_order_id FOR UPDATE;
 SELECT * INTO audit FROM operation_events WHERE event_id=NEW.operation_event_id;
 IF NEW.business_date>(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date
 OR (NEW.status='production_completed' AND NEW.business_date<(SELECT max(business_date) FROM effective_sourcing_production_reports
   WHERE production_order_id=NEW.production_order_id AND factory_decision_id IS NOT DISTINCT FROM NEW.factory_decision_id AND quantity>0))
 OR NOT (COALESCE(audit.actor_roles @> ARRAY['root_superuser']::text[],false) OR
  (audit.authorization_capability='production-reporting' AND audit.actor_roles @> ARRAY['production_reporter']::text[]
   AND sourcing_production_factory_reporter_allowed(NEW.actor_id,NEW.production_order_id,NEW.factory_decision_id)))
 THEN RAISE EXCEPTION 'production execution requires reporter scope and valid business date' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END; $$;
CREATE OR REPLACE FUNCTION guard_sourcing_production_transition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous sourcing_production_transitions%ROWTYPE; production sourcing_production_orders%ROWTYPE; expected_action text;
BEGIN
  SELECT * INTO production FROM sourcing_production_orders WHERE production_order_id=NEW.production_order_id FOR UPDATE;
  SELECT * INTO previous FROM sourcing_production_transitions WHERE production_order_id=NEW.production_order_id AND factory_decision_id IS NOT DISTINCT FROM NEW.factory_decision_id ORDER BY sequence DESC LIMIT 1;
  IF previous.production_transition_id IS NULL THEN
    IF NEW.factory_decision_id IS NOT NULL THEN
      IF NEW.sequence<>1 OR NEW.status<>'in_production' OR NOT EXISTS(SELECT 1 FROM sourcing_production_factory_transfers transfer
        JOIN operation_events event ON event.event_id=transfer.operation_event_id
        WHERE transfer.factory_decision_id=NEW.factory_decision_id AND transfer.production_order_id=NEW.production_order_id
          AND transfer.operation_event_id=NEW.operation_event_id AND event.actor_id=NEW.actor_id
          AND (transfer.effective_at AT TIME ZONE 'Asia/Shanghai')::date=NEW.business_date)
      THEN RAISE EXCEPTION 'new factory execution must start with its approved transfer' USING ERRCODE='23514'; END IF;
      RETURN NEW;
    END IF;
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
    AND event.after_state->>'factoryDecisionId' IS NOT DISTINCT FROM NEW.factory_decision_id::text
    AND event.entity_type='sourcing_production_order' AND event.entity_id=NEW.production_order_id::text)
  THEN RAISE EXCEPTION 'production transition requires matching audit' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END;
$$;
CREATE OR REPLACE FUNCTION guard_sourcing_production_shipment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM sourcing_production_orders production JOIN sourcing_production_transitions transition USING(production_order_id)
   JOIN operation_events event ON event.event_id=NEW.operation_event_id
   WHERE production.production_order_id=NEW.production_order_id
     AND EXISTS(SELECT 1 FROM sourcing_style_aliases alias WHERE alias.sourcing_case_id=production.sourcing_case_id AND alias.position=1 AND alias.style_no=NEW.first_style_no)
     AND event.after_state->>'firstStyleNo'=NEW.first_style_no
     AND transition.factory_decision_id IS NOT DISTINCT FROM NEW.factory_decision_id AND transition.status='shipped' AND transition.business_date=NEW.shipped_on AND transition.actor_id=NEW.actor_id
     AND transition.operation_event_id=NEW.operation_event_id)
   OR NEW.recorded_quantity<>(SELECT COALESCE(sum(quantity),0) FROM effective_sourcing_production_reports WHERE production_order_id=NEW.production_order_id AND factory_decision_id IS NOT DISTINCT FROM NEW.factory_decision_id)
 THEN RAISE EXCEPTION 'shipment must match production shipping transition' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END; $$;
CREATE OR REPLACE FUNCTION capture_sourcing_production_progress() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.status='production_completed' THEN
   INSERT INTO sourcing_production_progress_snapshots(production_order_id,production_transition_id,completed_quantity,first_reported_on,last_updated_at,factory_decision_id)
   SELECT NEW.production_order_id,NEW.production_transition_id,COALESCE(sum(quantity),0)::integer,
     min(business_date) FILTER(WHERE quantity>0),max(created_at),NEW.factory_decision_id
   FROM effective_sourcing_production_reports WHERE production_order_id=NEW.production_order_id AND factory_decision_id IS NOT DISTINCT FROM NEW.factory_decision_id;
 END IF;
 RETURN NEW;
END; $$;
CREATE OR REPLACE FUNCTION guard_sourcing_production_progress_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM sourcing_production_transitions transition WHERE transition.production_transition_id=NEW.production_transition_id
   AND transition.production_order_id=NEW.production_order_id AND transition.factory_decision_id IS NOT DISTINCT FROM NEW.factory_decision_id AND transition.status='production_completed')
 OR NEW.completed_quantity IS DISTINCT FROM (SELECT COALESCE(sum(quantity),0)::integer FROM effective_sourcing_production_reports WHERE production_order_id=NEW.production_order_id AND factory_decision_id IS NOT DISTINCT FROM NEW.factory_decision_id)
 OR NEW.first_reported_on IS DISTINCT FROM (SELECT min(business_date) FROM effective_sourcing_production_reports WHERE production_order_id=NEW.production_order_id AND factory_decision_id IS NOT DISTINCT FROM NEW.factory_decision_id AND quantity>0)
 OR NEW.last_updated_at IS DISTINCT FROM (SELECT max(created_at) FROM effective_sourcing_production_reports WHERE production_order_id=NEW.production_order_id AND factory_decision_id IS NOT DISTINCT FROM NEW.factory_decision_id)
 THEN RAISE EXCEPTION 'production progress snapshot must match completion facts' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END; $$;
CREATE OR REPLACE FUNCTION guard_sourcing_production_receipt_link()
RETURNS trigger LANGUAGE plpgsql AS $production_receipt$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM receiving_receipts receipt
    JOIN sourcing_production_shipments shipment
      ON shipment.production_order_id=NEW.production_order_id AND shipment.factory_decision_id IS NOT DISTINCT FROM NEW.factory_decision_id
    JOIN sourcing_production_factory_orders production
      ON production.production_order_id=shipment.production_order_id AND production.factory_decision_id IS NOT DISTINCT FROM shipment.factory_decision_id
    JOIN operation_events event
      ON event.event_id=NEW.operation_event_id
    WHERE receipt.receipt_id=NEW.receipt_id
      AND receipt.operation_event_id=NEW.operation_event_id
      AND (receipt.received_at AT TIME ZONE 'Asia/Shanghai')::date>=shipment.shipped_on
      AND event.action='receiving.receipt.create'
      AND event.entity_type='receiving_receipt'
      AND event.entity_id=NEW.receipt_id::text
      AND event.after_state->>'factoryDecisionId' IS NOT DISTINCT FROM NEW.factory_decision_id::text
      AND (
        (
          receipt.cutting_order_id IS NULL
          AND EXISTS(SELECT 1 FROM sourcing_factory_execution_lines(production.production_order_id,production.sourcing_decision_id) allocation WHERE allocation.position=1 AND allocation.quantity>0)
          AND EXISTS (
            SELECT 1
            FROM sourcing_style_aliases alias
            WHERE alias.sourcing_case_id=production.sourcing_case_id
              AND alias.position=1
              AND upper(btrim(alias.style_no))=upper(btrim(receipt.style_no))
          )
          AND event.after_state->>'productionOrderId'=NEW.production_order_id::text
        )
        OR
        (
          receipt.cutting_order_id IS NOT NULL
          AND event.after_state->>'cuttingOrderId'=receipt.cutting_order_id::text
          AND EXISTS (
            SELECT 1
            FROM cutting_orders cutting
            JOIN sourcing_style_aliases alias
              ON alias.sourcing_case_id=cutting.sourcing_case_id
             AND alias.position=cutting.sourcing_line_position
            WHERE cutting.cutting_order_id=receipt.cutting_order_id
              AND cutting.sourcing_case_id=production.sourcing_case_id
              AND EXISTS(SELECT 1 FROM sourcing_factory_execution_lines(production.production_order_id,production.sourcing_decision_id) allocation WHERE allocation.position=cutting.sourcing_line_position AND allocation.quantity>0)
              AND upper(btrim(alias.style_no))=upper(btrim(receipt.style_no))
          )
          AND EXISTS (
            SELECT 1
            FROM sourcing_production_pilots pilot
            WHERE pilot.supplier_id=production.supplier_id
              AND pilot.enabled=true
          )
          AND NOT EXISTS (
            SELECT 1
            FROM sourcing_production_exclusions exclusion
            WHERE exclusion.production_order_id=production.production_order_id
          )
        )
      )
  ) THEN
    RAISE EXCEPTION 'receipt link must match shipped production source and actual receipt audit'
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$production_receipt$;

CREATE FUNCTION sourcing_factory_delivery_date(decision_id uuid,fallback_date date,at_time timestamptz DEFAULT NULL)
RETURNS date LANGUAGE plpgsql STABLE AS $$ DECLARE edited text; BEGIN
 SELECT content.content->>'deliveryDate' INTO edited FROM sourcing_contract_documents document LEFT JOIN sourcing_contract_content_overrides content USING(sourcing_contract_document_id)
 WHERE document.sourcing_decision_id=decision_id AND (at_time IS NULL OR document.prepared_at<=at_time) ORDER BY document.contract_version DESC LIMIT 1;
 IF edited IS NULL OR edited !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN RETURN fallback_date; END IF;
 RETURN edited::date; EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN RETURN fallback_date; END $$;
-- Read-only projections preserve one production identity and the original frozen dispatch.
CREATE VIEW sourcing_production_factory_orders AS
 SELECT projected.*,execution.factory_decision_id
 FROM sourcing_production_orders original
 CROSS JOIN LATERAL (
   SELECT NULL::uuid AS factory_decision_id,original.sourcing_decision_id AS decision_id
   UNION ALL SELECT transfer.factory_decision_id,transfer.factory_decision_id
    FROM sourcing_production_factory_transfers transfer WHERE transfer.production_order_id=original.production_order_id
 ) execution
 JOIN sourcing_decisions decision ON decision.sourcing_decision_id=execution.decision_id
 JOIN sourcing_approval_snapshots approval ON approval.sourcing_decision_id=decision.sourcing_decision_id
 JOIN LATERAL (SELECT document.* FROM sourcing_contract_documents document WHERE document.sourcing_decision_id=decision.sourcing_decision_id
  ORDER BY document.contract_version DESC LIMIT 1) document ON true
 CROSS JOIN LATERAL jsonb_populate_record(NULL::sourcing_production_orders,to_jsonb(original)||jsonb_build_object(
  'sourcing_decision_id',decision.sourcing_decision_id,'sourcing_approval_snapshot_id',approval.sourcing_approval_snapshot_id,
  'decision_version',decision.decision_version,'supplier_id',approval.supplier_id,'supplier_name_snapshot',approval.supplier_name_snapshot,
  'sourcing_contract_document_id',document.sourcing_contract_document_id,'contract_number',document.contract_number,'contract_version',document.contract_version,
  'quantity',(SELECT COALESCE(sum(quantity),0) FROM sourcing_factory_execution_lines(original.production_order_id,decision.sourcing_decision_id)),
  'delivery_date',sourcing_factory_delivery_date(decision.sourcing_decision_id,approval.delivery_date)
 )) projected;

CREATE FUNCTION sourcing_factory_order_status(order_id uuid,at_time timestamptz DEFAULT NULL)
RETURNS text LANGUAGE sql STABLE AS $$
 SELECT CASE min(current.sequence) WHEN 1 THEN 'in_production' WHEN 2 THEN 'production_completed' WHEN 3 THEN 'shipped' ELSE 'in_production' END
 FROM (SELECT DISTINCT ON(transition.factory_decision_id) transition.factory_decision_id,transition.sequence
  FROM sourcing_production_transitions transition WHERE transition.production_order_id=order_id AND (at_time IS NULL OR transition.created_at<=at_time)
  ORDER BY transition.factory_decision_id,transition.sequence DESC) current
 JOIN sourcing_production_orders production ON production.production_order_id=order_id
 WHERE EXISTS(SELECT 1 FROM sourcing_factory_execution_lines(order_id,COALESCE(current.factory_decision_id,production.sourcing_decision_id),at_time) line WHERE line.quantity>0);
$$;

CREATE OR REPLACE FUNCTION guard_sourcing_reconciliation_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  source_decision sourcing_decisions%ROWTYPE;
  source_approval sourcing_approval_snapshots%ROWTYPE;
  source_contract sourcing_contract_documents%ROWTYPE;
  previous_version integer;
  expected_action text; factory sourcing_production_factory_orders%ROWTYPE; allocated_amount numeric; audit operation_events%ROWTYPE;
BEGIN
  PERFORM 1 FROM sourcing_cases
  WHERE sourcing_case_id=NEW.sourcing_case_id FOR UPDATE;
  IF NEW.factory_decision_id IS NOT NULL THEN
    SELECT * INTO factory FROM sourcing_production_factory_orders WHERE sourcing_case_id=NEW.sourcing_case_id AND sourcing_decision_id=NEW.factory_decision_id;
    SELECT * INTO source_approval FROM sourcing_approval_snapshots WHERE sourcing_approval_snapshot_id=factory.sourcing_approval_snapshot_id;
    SELECT * INTO source_decision FROM sourcing_decisions WHERE sourcing_decision_id=NEW.factory_decision_id;
    SELECT * INTO source_contract FROM sourcing_contract_documents WHERE sourcing_contract_document_id=factory.sourcing_contract_document_id;
    SELECT COALESCE(sum(round(allocation.quantity*line.unit_price,2)),0) INTO allocated_amount
      FROM sourcing_factory_execution_lines(factory.production_order_id,NEW.factory_decision_id) allocation
      JOIN sourcing_approval_snapshot_lines line ON line.sourcing_approval_snapshot_id=factory.sourcing_approval_snapshot_id AND line.position=allocation.position;
    SELECT COALESCE(max(reconciliation_version),0) INTO previous_version FROM sourcing_finance_reconciliations WHERE sourcing_case_id=NEW.sourcing_case_id;
    SELECT * INTO audit FROM operation_events WHERE event_id=NEW.operation_event_id;
    expected_action:=CASE NEW.result WHEN 'match' THEN 'sourcing.finance.matched' ELSE 'sourcing.finance.difference' END;
    IF factory.production_order_id IS NULL OR factory.quantity<=0
     OR NOT EXISTS(SELECT 1 FROM sourcing_production_factory_transfers transfer WHERE transfer.production_order_id=factory.production_order_id)
     OR NEW.sourcing_decision_id IS DISTINCT FROM NEW.factory_decision_id OR NEW.reconciliation_version<>previous_version+1
     OR NEW.sourcing_contract_document_id IS DISTINCT FROM source_contract.sourcing_contract_document_id OR source_contract.status<>'ready'
     OR source_contract.pdf_attachment_id IS NULL OR NEW.contract_version<>source_contract.contract_version OR NEW.contract_fingerprint<>source_contract.snapshot_fingerprint
     OR NEW.actual_supplier_id<>source_approval.supplier_id OR NEW.actual_supplier_code_snapshot<>source_approval.supplier_code_snapshot OR NEW.actual_supplier_name_snapshot<>source_approval.supplier_name_snapshot
     OR NEW.actual_unit_price<>source_decision.unit_price OR NEW.actual_quantity<>factory.quantity OR NEW.actual_total_amount<>allocated_amount
     OR audit.after_state->>'factoryDecisionId' IS DISTINCT FROM NEW.factory_decision_id::text
     OR audit.after_state->>'reconciliationId' IS DISTINCT FROM NEW.sourcing_reconciliation_id::text
     OR (NEW.result='match' AND (cardinality(NEW.difference_fields)<>0 OR NEW.difference_reason IS NOT NULL))
     OR (NEW.result='difference' AND (cardinality(NEW.difference_fields)=0 OR NOT (NEW.difference_fields <@ ARRAY['supplier','unit_price','quantity','total_amount']::text[]) OR NEW.difference_reason IS NULL))
    THEN RAISE EXCEPTION 'factory reconciliation must match its actual allocated quantity, approved prices and ready contract' USING ERRCODE='23514'; END IF;
    PERFORM sourcing_require_operation_event(NEW.operation_event_id,NEW.request_id,NEW.reconciled_by,expected_action,'sourcing:finance:reconcile',NEW.sourcing_case_id,NEW.difference_reason);
    RETURN NEW;
  END IF;
  SELECT * INTO source_decision
  FROM sourcing_decisions
  WHERE sourcing_case_id=NEW.sourcing_case_id
  ORDER BY decision_version DESC LIMIT 1;
  SELECT * INTO source_approval
  FROM sourcing_approval_snapshots
  WHERE sourcing_decision_id=source_decision.sourcing_decision_id;
  SELECT * INTO source_contract
  FROM sourcing_contract_documents
  WHERE sourcing_contract_document_id=NEW.sourcing_contract_document_id;
  SELECT COALESCE(max(reconciliation_version),0) INTO previous_version
  FROM sourcing_finance_reconciliations
  WHERE sourcing_case_id=NEW.sourcing_case_id;

  IF sourcing_current_status(NEW.sourcing_case_id)<>'pending_finance_reconciliation'
    OR source_decision.sourcing_decision_id IS NULL
    OR source_approval.sourcing_approval_snapshot_id IS NULL
    OR NEW.sourcing_decision_id<>source_decision.sourcing_decision_id
    OR NEW.reconciliation_version<>previous_version+1 THEN
    RAISE EXCEPTION 'finance reconciliation must bind the current approved sourcing decision'
      USING ERRCODE='23514';
  END IF;
  IF source_contract.sourcing_contract_document_id IS NULL
    OR source_contract.status<>'ready'
    OR source_contract.sourcing_case_id<>NEW.sourcing_case_id
    OR source_contract.sourcing_approval_snapshot_id<>source_approval.sourcing_approval_snapshot_id
    OR NEW.contract_version<>source_contract.contract_version
    OR NEW.contract_fingerprint<>source_contract.snapshot_fingerprint THEN
    RAISE EXCEPTION 'finance reconciliation must bind the ready system contract PDF'
      USING ERRCODE='23514';
  END IF;
  IF NEW.actual_supplier_id<>source_approval.supplier_id
    OR NEW.actual_supplier_code_snapshot<>source_approval.supplier_code_snapshot
    OR NEW.actual_supplier_name_snapshot<>source_approval.supplier_name_snapshot
    OR NEW.actual_unit_price<>source_decision.unit_price
    OR NEW.actual_quantity<>source_approval.quantity
    OR NEW.actual_total_amount<>source_approval.total_amount THEN
    RAISE EXCEPTION 'finance facts must be copied from the immutable approval snapshot'
      USING ERRCODE='23514';
  END IF;
  IF (NEW.result='match' AND (cardinality(NEW.difference_fields)<>0 OR NEW.difference_reason IS NOT NULL))
    OR (NEW.result='difference' AND (
      cardinality(NEW.difference_fields)=0
      OR NOT (NEW.difference_fields <@ ARRAY['supplier','unit_price','quantity','total_amount']::text[])
      OR NEW.difference_reason IS NULL
    )) THEN
    RAISE EXCEPTION 'finance reconciliation declaration is invalid'
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

CREATE OR REPLACE FUNCTION guard_sourcing_current_contract() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM sourcing_cases WHERE sourcing_case_id=NEW.sourcing_case_id FOR UPDATE;
  IF TG_TABLE_NAME='sourcing_finance_reconciliations' AND to_jsonb(NEW)->>'factory_decision_id' IS NOT NULL THEN
    IF NEW.sourcing_contract_document_id IS DISTINCT FROM (SELECT sourcing_contract_document_id FROM sourcing_contract_documents
      WHERE sourcing_case_id=NEW.sourcing_case_id AND sourcing_decision_id=(to_jsonb(NEW)->>'factory_decision_id')::uuid ORDER BY contract_version DESC LIMIT 1)
    THEN RAISE EXCEPTION 'factory reconciliation requires its latest contract revision' USING ERRCODE='55000'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.sourcing_contract_document_id IS DISTINCT FROM (
    SELECT sourcing_contract_document_id FROM sourcing_contract_documents
    WHERE sourcing_case_id=NEW.sourcing_case_id ORDER BY contract_version DESC LIMIT 1
  ) THEN RAISE EXCEPTION 'operation requires latest contract revision' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END; $$;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='dx_rework_acceptance_app') THEN
  GRANT SELECT ON sourcing_production_factory_orders TO dx_rework_acceptance_app;
 END IF;
END $$;
