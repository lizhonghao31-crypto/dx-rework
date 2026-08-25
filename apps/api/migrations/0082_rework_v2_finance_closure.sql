-- PR-07 Finance closure: normal deductions close only at exact equality.
-- Partial or failed deductions are routed to one direct finance director,
-- whose append-only decision either closes the exception or returns it.

DROP TRIGGER capability_catalog_no_insert ON capability_catalog;
DROP TRIGGER role_capabilities_no_insert ON role_capabilities;
DROP TRIGGER business_roles_no_insert ON business_roles;

INSERT INTO capability_catalog(capability,display_name,description) VALUES
  ('external_deduction:special_approve','外部扣款特批','确认或退回部分扣款及未扣异常')
ON CONFLICT DO NOTHING;

INSERT INTO business_roles(role_code,display_name,description) VALUES
  ('finance_director','财务总监','处理外部扣款部分扣与未扣异常特批')
ON CONFLICT DO NOTHING;

INSERT INTO role_capabilities(role_code,capability) VALUES
  ('finance_director','tools:user'),
  ('finance_director','finance:read'),
  ('finance_director','external_responsibility:view'),
  ('finance_director','external_deduction:special_approve')
ON CONFLICT DO NOTHING;

CREATE TRIGGER capability_catalog_no_insert BEFORE INSERT ON capability_catalog
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER role_capabilities_no_insert BEFORE INSERT ON role_capabilities
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER business_roles_no_insert BEFORE INSERT ON business_roles
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();

CREATE OR REPLACE FUNCTION external_responsibility_can_view_all(candidate uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT external_responsibility_direct_role(
    candidate,'external_responsibility:view',
    ARRAY['production_management','owner_group','tail_supervisor','finance_read','finance_director']
  )
$$;

DO $$
DECLARE constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT conname FROM pg_constraint
    WHERE conrelid='rework_external_responsibility_cases'::regclass
      AND contype='c'
      AND pg_get_constraintdef(oid) ILIKE '%pending_responsibility_revision%'
  LOOP
    EXECUTE format(
      'ALTER TABLE rework_external_responsibility_cases DROP CONSTRAINT %I',
      constraint_name
    );
  END LOOP;
END $$;

ALTER TABLE rework_external_responsibility_cases
  ADD CONSTRAINT rework_external_case_status_v2_check CHECK(status IN (
    'pending_business_signoff','pending_payables_confirmation','deduction_follow_up',
    'pending_special_approval','returned','pending_responsibility_revision',
    'closed','superseded'
  ));

CREATE TABLE rework_external_deduction_special_requests (
  special_request_id uuid PRIMARY KEY,
  case_id uuid NOT NULL REFERENCES rework_external_responsibility_cases,
  request_version integer NOT NULL CHECK(request_version>0),
  proposed_amount_snapshot numeric(18,2) NOT NULL CHECK(proposed_amount_snapshot>0),
  actual_deducted_amount_snapshot numeric(18,2) NOT NULL CHECK(actual_deducted_amount_snapshot>=0),
  remaining_amount_snapshot numeric(18,2) NOT NULL CHECK(remaining_amount_snapshot>0),
  reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 500),
  attachment_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  requested_by uuid NOT NULL REFERENCES app_users,
  operation_event_id uuid NOT NULL REFERENCES operation_events,
  request_id text NOT NULL CHECK(request_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  requested_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(case_id,request_version),
  CHECK(remaining_amount_snapshot=proposed_amount_snapshot-actual_deducted_amount_snapshot)
);

CREATE TABLE rework_external_deduction_special_decisions (
  special_decision_id uuid PRIMARY KEY,
  special_request_id uuid NOT NULL UNIQUE
    REFERENCES rework_external_deduction_special_requests,
  decision text NOT NULL CHECK(decision IN ('approved','returned')),
  reason text CHECK(reason IS NULL OR length(btrim(reason)) BETWEEN 1 AND 2000),
  decided_by uuid NOT NULL REFERENCES app_users,
  operation_event_id uuid NOT NULL REFERENCES operation_events,
  request_id text NOT NULL CHECK(request_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  decided_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK(decision='approved' OR reason IS NOT NULL)
);

ALTER TABLE rework_external_deduction_closures
  ADD COLUMN special_request_id uuid UNIQUE
  REFERENCES rework_external_deduction_special_requests;

DO $$
DECLARE constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT conname FROM pg_constraint
    WHERE conrelid='rework_external_deduction_closures'::regclass
      AND contype='c'
      AND pg_get_constraintdef(oid) ILIKE '%result%'
  LOOP
    EXECUTE format(
      'ALTER TABLE rework_external_deduction_closures DROP CONSTRAINT %I',
      constraint_name
    );
  END LOOP;
END $$;

ALTER TABLE rework_external_deduction_closures
  ADD CONSTRAINT rework_external_closure_result_v2_check
    CHECK(result IN ('full','partial','not_deducted')),
  ADD CONSTRAINT rework_external_closure_fact_v2_check CHECK(
    (result='full' AND actual_deducted_amount=proposed_amount
      AND remaining_amount=0 AND reason IS NULL
      AND remaining_difference_disposition IS NULL
      AND special_request_id IS NULL)
    OR
    (result='partial' AND actual_deducted_amount>0
      AND actual_deducted_amount<proposed_amount
      AND length(btrim(reason)) BETWEEN 1 AND 500
      AND remaining_difference_disposition IS NOT NULL
      AND length(btrim(remaining_difference_disposition)) BETWEEN 1 AND 500
      AND (special_request_id IS NOT NULL OR cardinality(evidence_attachment_ids)>0))
    OR
    (result='not_deducted' AND actual_deducted_amount=0
      AND remaining_amount=proposed_amount
      AND length(btrim(reason)) BETWEEN 1 AND 500
      AND remaining_difference_disposition IS NOT NULL
      AND length(btrim(remaining_difference_disposition)) BETWEEN 1 AND 500
      AND (special_request_id IS NOT NULL OR cardinality(evidence_attachment_ids)>0))
  );

CREATE OR REPLACE FUNCTION guard_external_special_request_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_case rework_external_responsibility_cases%ROWTYPE;
  actual numeric(18,2);
BEGIN
  SELECT * INTO target_case FROM rework_external_responsibility_cases
  WHERE case_id=NEW.case_id FOR UPDATE;
  SELECT COALESCE(sum(amount),0) INTO actual
  FROM rework_external_deduction_entries WHERE case_id=NEW.case_id;
  IF target_case.case_id IS NULL OR target_case.status<>'deduction_follow_up'
     OR NOT external_responsibility_can_payables(
       NEW.requested_by,target_case.rework_order_id,target_case.responsibility_type
     )
     OR NEW.proposed_amount_snapshot<>target_case.proposed_deduction_amount
     OR NEW.actual_deducted_amount_snapshot<>actual
     OR NEW.remaining_amount_snapshot<>target_case.proposed_deduction_amount-actual
     OR NEW.remaining_amount_snapshot<=0
     OR NEW.request_version<>(
       SELECT COALESCE(max(existing.request_version),0)+1
       FROM rework_external_deduction_special_requests existing
       WHERE existing.case_id=NEW.case_id
     ) THEN
    RAISE EXCEPTION 'special approval request does not match the current deduction exception'
      USING ERRCODE='23514';
  END IF;
  PERFORM external_responsibility_require_ready_attachments(NEW.attachment_ids);
  PERFORM external_responsibility_require_bound_attachments(NEW.attachment_ids,NEW.case_id);
  PERFORM require_external_responsibility_event(
    'rework.external_deduction.special.request','external_deduction:close',
    target_case.rework_order_id,NEW.requested_by
  );
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION guard_external_special_decision_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  source rework_external_deduction_special_requests%ROWTYPE;
  target_case rework_external_responsibility_cases%ROWTYPE;
BEGIN
  SELECT * INTO source FROM rework_external_deduction_special_requests
  WHERE special_request_id=NEW.special_request_id FOR KEY SHARE;
  SELECT * INTO target_case FROM rework_external_responsibility_cases
  WHERE case_id=source.case_id FOR UPDATE;
  IF source.special_request_id IS NULL
     OR target_case.status<>'pending_special_approval'
     OR EXISTS(
       SELECT 1 FROM rework_external_deduction_special_decisions
       WHERE special_request_id=NEW.special_request_id
     )
     OR NOT external_responsibility_direct_role(
       NEW.decided_by,'external_deduction:special_approve',ARRAY['finance_director']
     ) THEN
    RAISE EXCEPTION 'finance director is not authorized for this pending special approval'
      USING ERRCODE='42501';
  END IF;
  PERFORM require_external_responsibility_event(
    'rework.external_deduction.special.'||NEW.decision,
    'external_deduction:special_approve',target_case.rework_order_id,NEW.decided_by
  );
  RETURN NEW;
END $$;

CREATE TRIGGER rework_external_special_request_guard
  BEFORE INSERT ON rework_external_deduction_special_requests
  FOR EACH ROW EXECUTE FUNCTION guard_external_special_request_insert();
CREATE TRIGGER rework_external_special_decision_guard
  BEFORE INSERT ON rework_external_deduction_special_decisions
  FOR EACH ROW EXECUTE FUNCTION guard_external_special_decision_insert();

CREATE OR REPLACE FUNCTION guard_external_closure_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_case rework_external_responsibility_cases%ROWTYPE;
  actual numeric(18,2);
  source rework_external_deduction_special_requests%ROWTYPE;
  special_decision rework_external_deduction_special_decisions%ROWTYPE;
BEGIN
  SELECT * INTO target_case FROM rework_external_responsibility_cases
  WHERE case_id=NEW.case_id FOR UPDATE;
  SELECT COALESCE(sum(amount),0) INTO actual
  FROM rework_external_deduction_entries WHERE case_id=NEW.case_id;
  IF target_case.case_id IS NULL
     OR NEW.proposed_amount<>target_case.proposed_deduction_amount
     OR NEW.actual_deducted_amount<>actual THEN
    RAISE EXCEPTION 'deduction closure does not match the current ledger'
      USING ERRCODE='23514';
  END IF;
  IF target_case.status='deduction_follow_up' THEN
    IF NEW.result<>'full' OR NEW.special_request_id IS NOT NULL
       OR NOT external_responsibility_can_payables(
         NEW.closed_by,target_case.rework_order_id,target_case.responsibility_type
       ) THEN
      RAISE EXCEPTION 'only an exactly matched deduction may close without special approval'
        USING ERRCODE='23514';
    END IF;
    PERFORM require_external_responsibility_event(
      'rework.external_deduction.close','external_deduction:close',
      target_case.rework_order_id,NEW.closed_by
    );
  ELSIF target_case.status='pending_special_approval' THEN
    SELECT * INTO source FROM rework_external_deduction_special_requests
    WHERE special_request_id=NEW.special_request_id AND case_id=NEW.case_id;
    SELECT * INTO special_decision FROM rework_external_deduction_special_decisions
    WHERE special_request_id=NEW.special_request_id AND decision='approved';
    IF source.special_request_id IS NULL OR special_decision.special_decision_id IS NULL
       OR NEW.closed_by<>special_decision.decided_by
       OR (NEW.proposed_amount,NEW.actual_deducted_amount,NEW.remaining_amount)
          IS DISTINCT FROM
          (source.proposed_amount_snapshot,source.actual_deducted_amount_snapshot,source.remaining_amount_snapshot) THEN
      RAISE EXCEPTION 'special closure requires the matching approved immutable request'
        USING ERRCODE='55000';
    END IF;
    PERFORM require_external_responsibility_event(
      'rework.external_deduction.special.approved',
      'external_deduction:special_approve',target_case.rework_order_id,NEW.closed_by
    );
  ELSE
    RAISE EXCEPTION 'deduction closure is not allowed from the current case state'
      USING ERRCODE='23514';
  END IF;
  PERFORM external_responsibility_require_ready_attachments(NEW.evidence_attachment_ids);
  PERFORM external_responsibility_require_bound_attachments(NEW.evidence_attachment_ids,NEW.case_id);
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION guard_external_case_update()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  expected_action text;
  decision rework_external_payables_actions%ROWTYPE;
  closure rework_external_deduction_closures%ROWTYPE;
  revision rework_external_responsibility_revision_requests%ROWTYPE;
  signoff rework_external_business_signoffs%ROWTYPE;
  batch rework_external_responsibility_batches%ROWTYPE;
  special_request rework_external_deduction_special_requests%ROWTYPE;
  special_decision rework_external_deduction_special_decisions%ROWTYPE;
  current_action text;
  current_capability text;
  current_actor uuid;
BEGIN
  IF NEW.case_id IS DISTINCT FROM OLD.case_id
     OR NEW.batch_id IS DISTINCT FROM OLD.batch_id
     OR NEW.rework_order_id IS DISTINCT FROM OLD.rework_order_id
     OR NEW.responsibility_type IS DISTINCT FROM OLD.responsibility_type
     OR NEW.supplier_id IS DISTINCT FROM OLD.supplier_id
     OR NEW.supplier_version IS DISTINCT FROM OLD.supplier_version
     OR NEW.supplier_code_snapshot IS DISTINCT FROM OLD.supplier_code_snapshot
     OR NEW.supplier_name_snapshot IS DISTINCT FROM OLD.supplier_name_snapshot
     OR NEW.supplier_type_snapshot IS DISTINCT FROM OLD.supplier_type_snapshot
     OR NEW.business_handler_user_id IS DISTINCT FROM OLD.business_handler_user_id
     OR NEW.payables_handler_role_snapshot IS DISTINCT FROM OLD.payables_handler_role_snapshot
     OR NEW.proposed_deduction_amount IS DISTINCT FROM OLD.proposed_deduction_amount
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.operation_event_id IS DISTINCT FROM OLD.operation_event_id
     OR NEW.request_id IS DISTINCT FROM OLD.request_id
     OR NEW.case_version<>OLD.case_version+1 THEN
    RAISE EXCEPTION 'external deduction case source facts are immutable'
      USING ERRCODE='55000';
  END IF;
  IF OLD.status='superseded' THEN
    RAISE EXCEPTION 'superseded case is immutable' USING ERRCODE='55000';
  END IF;
  IF OLD.status='deduction_follow_up' AND NEW.status='deduction_follow_up' THEN
    SELECT action,authorization_capability,actor_id
      INTO current_action,current_capability,current_actor
    FROM operation_events
    WHERE event_id=nullif(current_setting('dx_rework.external_responsibility_event_id',true),'')::uuid
      AND request_id=nullif(current_setting('dx_rework.external_responsibility_request_id',true),'');
    IF (current_action,current_capability) NOT IN (
      ('rework.external_deduction.follow_up','external_deduction:follow_up'),
      ('rework.external_deduction.record','external_deduction:record')
    ) THEN RAISE EXCEPTION 'ledger case version requires a matching append-only action' USING ERRCODE='55000'; END IF;
    PERFORM require_external_responsibility_event(current_action,current_capability,NEW.rework_order_id,current_actor);
  ELSIF OLD.status='deduction_follow_up' AND NEW.status='pending_special_approval' THEN
    SELECT * INTO special_request FROM rework_external_deduction_special_requests
    WHERE case_id=NEW.case_id ORDER BY request_version DESC LIMIT 1;
    IF special_request.special_request_id IS NULL THEN
      RAISE EXCEPTION 'special approval transition requires an immutable request' USING ERRCODE='55000';
    END IF;
    PERFORM require_external_responsibility_event(
      'rework.external_deduction.special.request','external_deduction:close',
      NEW.rework_order_id,special_request.requested_by
    );
  ELSIF OLD.status='pending_special_approval'
     AND NEW.status IN ('deduction_follow_up','closed') THEN
    SELECT source.* INTO special_request
    FROM rework_external_deduction_special_requests source
    JOIN rework_external_deduction_special_decisions result USING(special_request_id)
    WHERE source.case_id=NEW.case_id
    ORDER BY source.request_version DESC LIMIT 1;
    SELECT result.* INTO special_decision
    FROM rework_external_deduction_special_decisions result
    WHERE result.special_request_id=special_request.special_request_id;
    IF special_decision.special_decision_id IS NULL
       OR special_decision.decision<>(CASE NEW.status WHEN 'closed' THEN 'approved' ELSE 'returned' END) THEN
      RAISE EXCEPTION 'special approval transition requires the matching decision' USING ERRCODE='55000';
    END IF;
    IF NEW.status='closed' THEN
      SELECT * INTO closure FROM rework_external_deduction_closures WHERE case_id=NEW.case_id;
      IF closure.special_request_id IS DISTINCT FROM special_request.special_request_id THEN
        RAISE EXCEPTION 'special approval closure is missing' USING ERRCODE='55000';
      END IF;
    END IF;
    PERFORM require_external_responsibility_event(
      'rework.external_deduction.special.'||special_decision.decision,
      'external_deduction:special_approve',NEW.rework_order_id,special_decision.decided_by
    );
  ELSIF NEW.status='pending_payables_confirmation'
     AND OLD.status IN ('pending_business_signoff','returned') THEN
    SELECT * INTO signoff FROM rework_external_business_signoffs
    WHERE case_id=NEW.case_id ORDER BY created_at DESC LIMIT 1;
    IF signoff.signoff_id IS NULL THEN RAISE EXCEPTION 'case submission requires append-only signoff' USING ERRCODE='55000'; END IF;
    PERFORM require_external_responsibility_event('rework.external_responsibility.submit','external_responsibility:sign',NEW.rework_order_id,signoff.submitted_by);
  ELSIF NEW.status IN ('deduction_follow_up','returned')
     AND OLD.status='pending_payables_confirmation' THEN
    SELECT * INTO decision FROM rework_external_payables_actions
    WHERE case_id=NEW.case_id ORDER BY created_at DESC LIMIT 1;
    expected_action:=CASE NEW.status WHEN 'deduction_follow_up' THEN 'rework.external_responsibility.payables_accept' ELSE 'rework.external_responsibility.payables_return' END;
    IF decision.payables_action_id IS NULL OR decision.action<>(CASE NEW.status WHEN 'deduction_follow_up' THEN 'accepted' ELSE 'returned' END) THEN RAISE EXCEPTION 'payables transition requires matching append-only action' USING ERRCODE='55000'; END IF;
    PERFORM require_external_responsibility_event(expected_action,'external_responsibility:payables_confirm',NEW.rework_order_id,decision.acted_by);
  ELSIF NEW.status='closed' AND OLD.status='deduction_follow_up' THEN
    SELECT * INTO closure FROM rework_external_deduction_closures WHERE case_id=NEW.case_id;
    IF closure.closure_id IS NULL OR closure.result<>'full' OR closure.special_request_id IS NOT NULL THEN RAISE EXCEPTION 'normal closure requires an exact full deduction' USING ERRCODE='55000'; END IF;
    PERFORM require_external_responsibility_event('rework.external_deduction.close','external_deduction:close',NEW.rework_order_id,closure.closed_by);
  ELSIF NEW.status='pending_responsibility_revision'
     AND OLD.status IN ('pending_business_signoff','returned','pending_payables_confirmation','deduction_follow_up','closed') THEN
    SELECT * INTO revision FROM rework_external_responsibility_revision_requests
    WHERE case_id=NEW.case_id AND status='pending' ORDER BY created_at DESC LIMIT 1;
    IF revision.revision_request_id IS NULL THEN RAISE EXCEPTION 'case revision requires append-only request record' USING ERRCODE='55000'; END IF;
    PERFORM require_external_responsibility_event('rework.external_responsibility.revision.request','external_responsibility:request_revision',NEW.rework_order_id,revision.requested_by);
  ELSIF NEW.status='superseded'
     AND OLD.status IN ('pending_business_signoff','returned','pending_payables_confirmation','deduction_follow_up','pending_special_approval','pending_responsibility_revision') THEN
    SELECT * INTO batch FROM rework_external_responsibility_batches WHERE batch_id=NEW.batch_id;
    IF NOT external_responsibility_superseded_by_finalization(batch.finalized_determination_id,NEW.rework_order_id) THEN
      SELECT actor_id INTO current_actor FROM operation_events WHERE event_id=nullif(current_setting('dx_rework.external_responsibility_event_id',true),'')::uuid;
      PERFORM require_external_responsibility_event('rework.external_responsibility.revision.approve','external_responsibility:approve_revision',NEW.rework_order_id,current_actor);
    END IF;
  ELSIF OLD.status='pending_responsibility_revision'
     AND NEW.status IN ('pending_business_signoff','returned','pending_payables_confirmation','deduction_follow_up','closed') THEN
    SELECT actor_id INTO current_actor FROM operation_events WHERE event_id=nullif(current_setting('dx_rework.external_responsibility_event_id',true),'')::uuid;
    PERFORM require_external_responsibility_event('rework.external_responsibility.revision.reject','external_responsibility:approve_revision',NEW.rework_order_id,current_actor);
  ELSE
    RAISE EXCEPTION 'invalid external deduction case transition' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'rework_external_deduction_special_requests',
    'rework_external_deduction_special_decisions'
  ] LOOP
    EXECUTE format('CREATE TRIGGER %I_no_update BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation()',table_name,table_name);
    EXECUTE format('CREATE TRIGGER %I_no_delete BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation()',table_name,table_name);
    EXECUTE format('CREATE TRIGGER %I_no_truncate BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION reject_operation_event_mutation()',table_name,table_name);
  END LOOP;
END $$;
