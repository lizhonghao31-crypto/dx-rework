-- Append-only compatibility: business dates use the original native order clock.
-- Audit timestamps, transfer quantity cutoffs, existing rows and authorizations are unchanged.
CREATE FUNCTION sourcing_production_clock_scope(target uuid)
RETURNS TABLE(native_order_id uuid, scenario_id uuid) LANGUAGE plpgsql AS $$
DECLARE case_id uuid; generation text; production_mother uuid; case_mother uuid;
BEGIN
 SELECT p.sourcing_case_id,c.workflow_generation INTO STRICT case_id,generation
 FROM sourcing_production_orders p JOIN sourcing_cases c USING(sourcing_case_id) WHERE p.production_order_id=target;
 SELECT l.production_order_id INTO production_mother FROM digital_production_child_links l WHERE l.module='production' AND l.child_id=target;
 SELECT l.production_order_id INTO case_mother FROM digital_production_child_links l WHERE l.module='sourcing' AND l.child_id=case_id;
 IF generation='digital_production_v1' THEN
  IF production_mother IS NULL OR case_mother IS DISTINCT FROM production_mother
  THEN RAISE EXCEPTION 'Production calendar requires the original native order and case links' USING ERRCODE='55000'; END IF;
 ELSIF production_mother IS NOT NULL OR case_mother IS NOT NULL THEN
  RAISE EXCEPTION 'Legacy production cannot claim a native order clock' USING ERRCODE='55000';
 END IF;
 RETURN QUERY SELECT production_mother,r.scenario_id FROM (SELECT 1) one_row
 LEFT JOIN acceptance_sla_clock_resources r ON r.resource_kind='order' AND r.resource_id=production_mother;
END;
$$;
CREATE FUNCTION sourcing_production_business_date(target uuid, audit_id uuid) RETURNS date LANGUAGE plpgsql AS $$
DECLARE scope record; scene acceptance_sla_clock_scenarios%ROWTYPE; audit operation_events%ROWTYPE; audit_xid text; transferred_at timestamptz;
BEGIN
 SELECT * INTO STRICT scope FROM sourcing_production_clock_scope(target);
 SELECT * INTO audit FROM operation_events WHERE event_id=audit_id;
 IF scope.scenario_id IS NULL THEN
  IF audit.after_state->'acceptanceClock' IS NOT NULL
  THEN RAISE EXCEPTION 'Ordinary production cannot claim an Acceptance clock' USING ERRCODE='55000'; END IF;
  -- Ordinary transfers keep their original statement-time audit boundary even
  -- when approval crosses midnight after the transaction began. No caller-supplied date.
  IF audit.action='sourcing.factory_change.effective' THEN
   SELECT transfer.effective_at INTO STRICT transferred_at FROM sourcing_production_factory_transfers transfer
    WHERE transfer.production_order_id=target AND transfer.operation_event_id=audit_id;
   RETURN (transferred_at AT TIME ZONE 'Asia/Shanghai')::date;
  END IF;
  RETURN (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date;
 END IF;
 SELECT * INTO STRICT scene FROM acceptance_sla_clock_scenarios WHERE scenario_id=scope.scenario_id FOR SHARE;
 SELECT xmin::text INTO audit_xid FROM operation_events WHERE event_id=audit_id;
 IF current_database() !~* '(^|[_-])(accept(ance)?|uat|test)([_-]|$)'
  OR audit.event_id IS NULL OR audit_xid IS DISTINCT FROM (txid_current()%4294967296)::text
  OR audit.after_state->'acceptanceClock'->>'scenarioId' IS DISTINCT FROM scene.scenario_id::text
  OR jsonb_typeof(audit.after_state->'acceptanceClock'->'revision') IS DISTINCT FROM 'number'
  OR audit.after_state->'acceptanceClock'->>'revision' IS DISTINCT FROM scene.version::text
  OR (audit.after_state->'acceptanceClock'->>'now')::timestamptz IS DISTINCT FROM scene.business_now
  OR NOT EXISTS(SELECT 1 FROM identity_mappings i JOIN app_users u ON u.id=i.user_id
    WHERE i.user_id=audit.actor_id AND u.enabled AND NOT u.manual_access_disabled
     AND i.provider='dingtalk' AND i.corp_id=scene.corporation_id AND i.provider_user_id LIKE 'uat-%'
     AND i.union_id LIKE 'uat-union-%' AND i.active AND i.employed)
  OR NOT EXISTS(SELECT 1 FROM owner_bootstrap_consumptions b JOIN identity_mappings i ON i.user_id=b.user_id
    JOIN app_users u ON u.id=b.user_id
    WHERE b.singleton AND b.provider_user_id='uat-root' AND b.corp_id=scene.corporation_id
     AND i.provider='dingtalk' AND i.provider_user_id=b.provider_user_id AND i.corp_id=b.corp_id
     AND i.union_id LIKE 'uat-union-%' AND i.active AND i.employed AND u.enabled AND NOT u.manual_access_disabled
     AND EXISTS(SELECT 1 FROM user_role_assignments r WHERE r.user_id=b.user_id AND r.role_code='owner_group' AND r.revoked_at IS NULL))
 THEN RAISE EXCEPTION 'Production calendar requires the current native scenario, clock version and UAT operation' USING ERRCODE='55000'; END IF;
 RETURN (scene.business_now AT TIME ZONE 'Asia/Shanghai')::date;
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
 IF NEW.business_date>sourcing_production_business_date(NEW.production_order_id,NEW.operation_event_id)
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
 IF NEW.business_date>sourcing_production_business_date(NEW.production_order_id,NEW.operation_event_id)
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
          AND sourcing_production_business_date(NEW.production_order_id,NEW.operation_event_id)=NEW.business_date)
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
