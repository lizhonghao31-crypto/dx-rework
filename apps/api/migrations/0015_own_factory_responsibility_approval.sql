-- PR-10: immutable N08-A own-factory approval, bound only to a finalized
-- responsibility snapshot. This migration intentionally does not implement
-- supplier selection, actual deductions, payroll, or a notification platform.

DROP TRIGGER capability_catalog_no_insert ON capability_catalog;
DROP TRIGGER role_capabilities_no_insert ON role_capabilities;
INSERT INTO capability_catalog(capability,display_name,description) VALUES
  ('own_factory:view','查看本厂承担审批','查看本厂承担审批快照和终局结果'),
  ('own_factory:approve','本厂承担审批','审批或驳回本厂承担终局事项')
ON CONFLICT DO NOTHING;
INSERT INTO role_capabilities(role_code,capability) VALUES
  ('production_management','own_factory:view'),
  ('owner_group','own_factory:view'),
  ('owner_group','own_factory:approve')
ON CONFLICT DO NOTHING;
CREATE TRIGGER capability_catalog_no_insert BEFORE INSERT ON capability_catalog
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER role_capabilities_no_insert BEFORE INSERT ON role_capabilities
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();

-- Approval delegation is exceptional: it must be explicit, active and scoped
-- to one rework order. The pre-existing delegation guard still verifies that
-- the grantor is the direct active owner.
CREATE FUNCTION guard_own_factory_delegation_scope()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.capability = 'own_factory:approve'
     AND (NEW.scope_type <> 'rework_order' OR NEW.scope_id IS NULL) THEN
    RAISE EXCEPTION 'own-factory approval delegation requires rework-order scope'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER delegated_authorizations_own_factory_scope
  BEFORE INSERT ON delegated_authorizations
  FOR EACH ROW EXECUTE FUNCTION guard_own_factory_delegation_scope();

CREATE FUNCTION own_factory_approval_can_decide(candidate uuid, order_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT responsibility_actor_has_direct_role(
    candidate,
    'own_factory:approve',
    ARRAY['owner_group']
  )
  OR (
    responsibility_actor_is_active(candidate)
    AND EXISTS (
      SELECT 1
      FROM delegated_authorizations delegation
      WHERE delegation.grantee_user_id = candidate
        AND delegation.capability = 'own_factory:approve'
        AND delegation.scope_type = 'rework_order'
        AND delegation.scope_id = order_id::text
        AND delegation.revoked_at IS NULL
        AND CURRENT_TIMESTAMP BETWEEN delegation.valid_from AND delegation.valid_until
        AND responsibility_actor_has_direct_role(
          delegation.grantor_user_id,
          'own_factory:approve',
          ARRAY['owner_group']
        )
    )
  )
$$;

CREATE FUNCTION own_factory_approval_can_view(candidate uuid, order_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT own_factory_approval_can_decide(candidate, order_id)
  OR responsibility_actor_has_direct_role(
    candidate,
    'responsibility:determine',
    ARRAY['production_management', 'owner_group']
  )
$$;

CREATE FUNCTION own_factory_approval_source_snapshot(version_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT jsonb_build_object(
    'finalizedDetermination',
      jsonb_build_object(
        'determinationId', determination.determination_id,
        'determinationVersion', determination.determination_version,
        'sourceOrderReviewId', determination.source_order_review_id,
        'calculationTotal', determination.calculation_total::text,
        'determinedBy', determination.created_by,
        'highMultiplierConfirmation',
          (
            SELECT jsonb_build_object(
              'confirmationId', confirmation.confirmation_id,
              'confirmedBy', confirmation.confirmed_by,
              'confirmedAt', to_char(
                confirmation.confirmed_at AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
              ),
              'reason', confirmation.reason,
              'snapshot', confirmation.confirmation_snapshot
            )
            FROM rework_responsibility_high_multiplier_confirmations confirmation
            WHERE confirmation.confirmation_id = determination.source_high_multiplier_confirmation_id
          )
      ),
    'order',
      jsonb_build_object(
        'reworkOrderId', order_record.rework_order_id,
        'reworkNo', order_record.rework_no,
        'styleNo', order_record.style_no,
        'orderNo', order_record.order_no,
        'problemPart', order_record.problem_part,
        'problemDescription', order_record.problem_description
      ),
    'processes',
      COALESCE((
        SELECT jsonb_agg(
          jsonb_build_object(
            'configurationItemId', process.configuration_item_id,
            'processName', process.process_name_snapshot,
            'pricingUnit', process.pricing_unit_snapshot,
            'baseAmount', process.base_amount::text,
            'responsibilityAmount', process.responsibility_amount::text,
            'multiplier', process.multiplier::text,
            'ownFactoryShareBps', allocation.share_bps,
            'ownFactoryRoundedAmount', allocation.rounded_amount::text
          )
          ORDER BY process.configuration_item_id
        )
        FROM rework_responsibility_processes process
        JOIN rework_responsibility_allocations allocation
          ON allocation.determination_id = process.determination_id
         AND allocation.configuration_item_id = process.configuration_item_id
         AND allocation.responsibility_type = 'own_factory'
        WHERE process.determination_id = determination.determination_id
      ), '[]'::jsonb),
    'amountLines',
      COALESCE((
        SELECT jsonb_agg(
          jsonb_build_object(
            'configurationItemId', line.configuration_item_id,
            'workReportId', line.work_report_id,
            'personId', line.person_id,
            'baseMemberShareAmount', line.base_member_share_amount::text,
            'multiplier', line.multiplier::text,
            'shareBps', line.share_bps,
            'roundedAmount', line.rounded_amount::text,
            'workerDisplayName', line.worker_display_name_snapshot,
            'taskMode', line.task_mode_snapshot,
            'memberSnapshot', line.member_snapshot,
            'reportSnapshot', line.report_snapshot
          )
          ORDER BY line.configuration_item_id, line.work_report_id, line.person_id
        )
        FROM rework_responsibility_amount_lines line
        WHERE line.determination_id = determination.determination_id
          AND line.responsibility_type = 'own_factory'
      ), '[]'::jsonb)
  )
  FROM rework_responsibility_determinations determination
  JOIN rework_orders order_record
    ON order_record.rework_order_id = determination.rework_order_id
  WHERE determination.determination_id = version_id
$$;

CREATE TABLE rework_own_factory_approvals (
  approval_id uuid PRIMARY KEY,
  rework_order_id uuid NOT NULL REFERENCES rework_orders,
  finalized_determination_id uuid NOT NULL UNIQUE
    REFERENCES rework_responsibility_determinations,
  finalized_determination_version integer NOT NULL CHECK(finalized_determination_version > 0),
  approval_version integer NOT NULL CHECK(approval_version > 0),
  status text NOT NULL CHECK(status IN ('pending', 'approved', 'rejected')),
  own_factory_total_amount numeric(18,2) NOT NULL CHECK(own_factory_total_amount > 0),
  source_snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_operation_event_id uuid NOT NULL REFERENCES operation_events(event_id),
  request_id text NOT NULL CHECK(request_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  UNIQUE(rework_order_id, finalized_determination_version)
);

CREATE TABLE rework_own_factory_approval_decisions (
  decision_id uuid PRIMARY KEY,
  approval_id uuid NOT NULL UNIQUE REFERENCES rework_own_factory_approvals,
  decision text NOT NULL CHECK(decision IN ('approved', 'rejected')),
  acted_by uuid NOT NULL REFERENCES app_users,
  actor_role_snapshot text[] NOT NULL CHECK(cardinality(actor_role_snapshot) > 0),
  opinion text,
  decided_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  operation_event_id uuid NOT NULL REFERENCES operation_events(event_id),
  request_id text NOT NULL CHECK(request_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  CHECK(decision <> 'rejected' OR length(btrim(opinion)) BETWEEN 1 AND 500),
  CHECK(opinion IS NULL OR length(btrim(opinion)) BETWEEN 1 AND 500)
);

CREATE FUNCTION require_own_factory_approval_context(
  expected_action text,
  expected_capability text,
  order_id uuid,
  persisted_actor uuid
)
RETURNS operation_events
LANGUAGE plpgsql
AS $$
DECLARE
  audit_event_id text := nullif(current_setting('dx_rework.own_factory_approval_event_id', true), '');
  audit_request_id text := nullif(current_setting('dx_rework.own_factory_approval_request_id', true), '');
  event_record operation_events%ROWTYPE;
BEGIN
  IF audit_event_id IS NULL OR audit_request_id IS NULL
     OR audit_request_id !~ '^[A-Za-z0-9._:-]{1,128}$' THEN
    RAISE EXCEPTION 'own-factory approval requires trusted audit context'
      USING ERRCODE = '55000';
  END IF;
  SELECT * INTO event_record
  FROM operation_events
  WHERE event_id = audit_event_id::uuid
    AND request_id = audit_request_id;
  IF event_record.event_id IS NULL
     OR event_record.actor_id <> persisted_actor
     OR event_record.action <> expected_action
     OR event_record.authorization_capability <> expected_capability
     OR event_record.entity_type <> 'rework_order'
     OR event_record.entity_id <> order_id::text THEN
    RAISE EXCEPTION 'own-factory approval event does not match write'
      USING ERRCODE = '55000';
  END IF;
  RETURN event_record;
END
$$;

CREATE FUNCTION guard_own_factory_approval_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  determination rework_responsibility_determinations%ROWTYPE;
  expected_total numeric(18,2);
  event_record operation_events%ROWTYPE;
BEGIN
  SELECT * INTO determination
  FROM rework_responsibility_determinations
  WHERE determination_id = NEW.finalized_determination_id;
  IF determination.determination_id IS NULL
     OR determination.rework_order_id <> NEW.rework_order_id
     OR determination.stage <> 'finalized'
     OR determination.determination_version <> NEW.finalized_determination_version
     OR EXISTS (
       SELECT 1 FROM rework_responsibility_determinations successor
       WHERE successor.replaces_determination_id = determination.determination_id
     ) THEN
    RAISE EXCEPTION 'approval must bind the current finalized responsibility version'
      USING ERRCODE = '23514';
  END IF;
  SELECT COALESCE(sum(rounded_amount), 0)
  INTO expected_total
  FROM rework_responsibility_allocations
  WHERE determination_id = NEW.finalized_determination_id
    AND responsibility_type = 'own_factory';
  IF expected_total <= 0
     OR NEW.own_factory_total_amount IS DISTINCT FROM expected_total
     OR NEW.source_snapshot IS DISTINCT FROM own_factory_approval_source_snapshot(
       NEW.finalized_determination_id
     )
     OR NEW.approval_version <> 1
     OR NEW.status <> 'pending' THEN
    RAISE EXCEPTION 'own-factory approval snapshot does not match finalized responsibility'
      USING ERRCODE = '23514';
  END IF;
  event_record := require_own_factory_approval_context(
    'rework.own_factory_approval.create',
    'responsibility:determine',
    NEW.rework_order_id,
    (SELECT actor_id FROM operation_events WHERE event_id = NEW.created_operation_event_id)
  );
  IF event_record.event_id <> NEW.created_operation_event_id
     OR event_record.request_id <> NEW.request_id
     OR NOT responsibility_can_determine(event_record.actor_id, NEW.rework_order_id) THEN
    RAISE EXCEPTION 'approval creation actor is not a valid responsibility handler'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;

CREATE FUNCTION guard_own_factory_approval_decision_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  approval rework_own_factory_approvals%ROWTYPE;
  event_record operation_events%ROWTYPE;
  expected_action text;
BEGIN
  SELECT * INTO approval
  FROM rework_own_factory_approvals
  WHERE approval_id = NEW.approval_id;
  IF approval.approval_id IS NULL OR approval.status <> 'pending' THEN
    RAISE EXCEPTION 'only a pending approval can receive one terminal decision'
      USING ERRCODE = '23514';
  END IF;
  expected_action := CASE NEW.decision
    WHEN 'approved' THEN 'rework.own_factory_approval.approve'
    WHEN 'rejected' THEN 'rework.own_factory_approval.reject'
  END;
  event_record := require_own_factory_approval_context(
    expected_action,
    'own_factory:approve',
    approval.rework_order_id,
    NEW.acted_by
  );
  IF event_record.event_id <> NEW.operation_event_id
     OR event_record.request_id <> NEW.request_id
     OR NEW.actor_role_snapshot IS DISTINCT FROM event_record.actor_roles
     OR NOT own_factory_approval_can_decide(NEW.acted_by, approval.rework_order_id) THEN
    RAISE EXCEPTION 'decision actor is not a valid own-factory approver'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;

CREATE FUNCTION guard_own_factory_approval_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  decision_record rework_own_factory_approval_decisions%ROWTYPE;
  expected_action text;
BEGIN
  IF NEW.approval_id IS DISTINCT FROM OLD.approval_id
     OR NEW.rework_order_id IS DISTINCT FROM OLD.rework_order_id
     OR NEW.finalized_determination_id IS DISTINCT FROM OLD.finalized_determination_id
     OR NEW.finalized_determination_version IS DISTINCT FROM OLD.finalized_determination_version
     OR NEW.own_factory_total_amount IS DISTINCT FROM OLD.own_factory_total_amount
     OR NEW.source_snapshot IS DISTINCT FROM OLD.source_snapshot
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.created_operation_event_id IS DISTINCT FROM OLD.created_operation_event_id
     OR NEW.request_id IS DISTINCT FROM OLD.request_id
     OR OLD.status <> 'pending'
     OR NEW.status NOT IN ('approved', 'rejected')
     OR NEW.approval_version <> OLD.approval_version + 1 THEN
    RAISE EXCEPTION 'own-factory approval history is immutable'
      USING ERRCODE = '55000';
  END IF;
  SELECT * INTO decision_record
  FROM rework_own_factory_approval_decisions
  WHERE approval_id = NEW.approval_id;
  expected_action := CASE NEW.status
    WHEN 'approved' THEN 'rework.own_factory_approval.approve'
    WHEN 'rejected' THEN 'rework.own_factory_approval.reject'
  END;
  IF decision_record.decision_id IS NULL
     OR decision_record.decision <> NEW.status
     OR decision_record.operation_event_id <> nullif(
       current_setting('dx_rework.own_factory_approval_event_id', true),
       ''
     )::uuid THEN
    RAISE EXCEPTION 'approval terminal state requires its matching append-only decision'
      USING ERRCODE = '55000';
  END IF;
  PERFORM require_own_factory_approval_context(
    expected_action,
    'own_factory:approve',
    NEW.rework_order_id,
    decision_record.acted_by
  );
  RETURN NEW;
END
$$;

CREATE TRIGGER rework_own_factory_approvals_guard_insert
  BEFORE INSERT ON rework_own_factory_approvals
  FOR EACH ROW EXECUTE FUNCTION guard_own_factory_approval_insert();
CREATE TRIGGER rework_own_factory_approvals_guard_update
  BEFORE UPDATE ON rework_own_factory_approvals
  FOR EACH ROW EXECUTE FUNCTION guard_own_factory_approval_update();
CREATE TRIGGER rework_own_factory_approvals_no_delete
  BEFORE DELETE ON rework_own_factory_approvals
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER rework_own_factory_approvals_no_truncate
  BEFORE TRUNCATE ON rework_own_factory_approvals
  FOR EACH STATEMENT EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER rework_own_factory_approval_decisions_guard_insert
  BEFORE INSERT ON rework_own_factory_approval_decisions
  FOR EACH ROW EXECUTE FUNCTION guard_own_factory_approval_decision_insert();
CREATE TRIGGER rework_own_factory_approval_decisions_no_update
  BEFORE UPDATE ON rework_own_factory_approval_decisions
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER rework_own_factory_approval_decisions_no_delete
  BEFORE DELETE ON rework_own_factory_approval_decisions
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER rework_own_factory_approval_decisions_no_truncate
  BEFORE TRUNCATE ON rework_own_factory_approval_decisions
  FOR EACH STATEMENT EXECUTE FUNCTION reject_operation_event_mutation();

-- Preserve the existing complete order guard and add only the N08-A rejection
-- return path. A rejection can return to N07 but can never modify history.
CREATE OR REPLACE FUNCTION guard_rework_order_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  audit_event_id text := nullif(current_setting('dx_rework.rework_event_id', true), '');
  audit_request_id text := nullif(current_setting('dx_rework.rework_request_id', true), '');
  expected_action text;
  expected_capability text;
  alternative_action text := NULL;
  alternative_capability text := NULL;
  alternative_action_two text := NULL;
  alternative_capability_two text := NULL;
  alternative_action_three text := NULL;
  alternative_capability_three text := NULL;
  audit_actor_id uuid;
BEGIN
  IF audit_event_id IS NULL OR audit_request_id IS NULL
     OR audit_request_id !~ '^[A-Za-z0-9._:-]{1,128}$' THEN
    RAISE EXCEPTION 'rework order write requires trusted audit context' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' OR NEW.version <> 1 OR NEW.rework_no IS NOT NULL
       OR NEW.submitted_at IS NOT NULL OR NEW.created_by <> NEW.updated_by
       OR NEW.source_system <> 'manual' OR NEW.external_id IS NOT NULL
       OR NEW.external_idempotency_key IS NOT NULL OR NEW.erp_node_id IS NOT NULL THEN
      RAISE EXCEPTION 'new manual rework orders must start as an unsubmitted draft' USING ERRCODE = '23514';
    END IF;
    expected_action := 'rework.draft.create';
    expected_capability := 'rework:initiate';
    audit_actor_id := NEW.created_by;
  ELSE
    IF NEW.rework_order_id IS DISTINCT FROM OLD.rework_order_id
       OR NEW.created_by IS DISTINCT FROM OLD.created_by
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR NEW.source_system IS DISTINCT FROM OLD.source_system
       OR NEW.external_id IS DISTINCT FROM OLD.external_id
       OR NEW.external_idempotency_key IS DISTINCT FROM OLD.external_idempotency_key
       OR NEW.erp_node_id IS DISTINCT FROM OLD.erp_node_id
       OR NEW.version <> OLD.version + 1 THEN
      RAISE EXCEPTION 'stable rework order identity and origin fields are immutable' USING ERRCODE = '55000';
    END IF;
    IF OLD.rework_no IS NOT NULL AND NEW.rework_no IS DISTINCT FROM OLD.rework_no THEN
      RAISE EXCEPTION 'allocated rework number is immutable' USING ERRCODE = '55000';
    END IF;
    IF OLD.submitted_at IS NOT NULL AND NEW.submitted_at IS DISTINCT FROM OLD.submitted_at THEN
      RAISE EXCEPTION 'first submission timestamp is immutable' USING ERRCODE = '55000';
    END IF;
    IF OLD.status = 'draft' AND NEW.status = 'draft' THEN
      expected_action := 'rework.draft.update'; expected_capability := 'rework:initiate';
    ELSIF OLD.status = 'draft' AND NEW.status = 'pending_process_configuration' THEN
      expected_action := 'rework.submit'; expected_capability := 'rework:initiate';
    ELSIF OLD.status = 'pending_process_configuration' AND NEW.status = 'draft' THEN
      expected_action := 'rework.withdraw'; expected_capability := 'rework:initiate';
    ELSIF OLD.status = 'pending_process_configuration' AND NEW.status IN ('pending_ie_review','pending_process_configuration') THEN
      expected_action := CASE WHEN NEW.status='pending_ie_review' THEN 'rework.process_configuration.submit' ELSE 'rework.process_configuration.save' END; expected_capability := 'process:configure';
    ELSIF OLD.status = 'pending_ie_review' AND NEW.status IN ('pending_process_configuration','pending_task_assignment') THEN
      expected_action := 'rework.process_configuration.review'; expected_capability := 'process:review';
    ELSIF OLD.status = 'pending_task_assignment' AND NEW.status IN ('pending_ie_review','pending_task_assignment') THEN
      expected_action := CASE WHEN NEW.status='pending_ie_review' THEN 'rework.process_configuration.submit' ELSE 'rework.process_configuration.save' END; expected_capability := 'process:configure';
    ELSIF OLD.status = 'pending_task_assignment' AND NEW.status = 'in_progress' THEN
      expected_action := 'rework.work_task.assign'; expected_capability := 'work:assign';
    ELSIF OLD.status = 'in_progress' AND NEW.status = 'in_progress' THEN
      expected_action := 'rework.quantity.decrease'; expected_capability := 'quantity:adjust';
    ELSIF OLD.status = 'in_progress' AND NEW.status = 'pending_order_review' THEN
      expected_action := 'rework.work_report.submit'; expected_capability := 'work:report';
      alternative_action := 'rework.quantity.decrease'; alternative_capability := 'quantity:adjust';
    ELSIF OLD.status = 'pending_order_review' AND NEW.status = 'pending_order_review' THEN
      expected_action := 'rework.quantity.decrease'; expected_capability := 'quantity:adjust';
      alternative_action := 'rework.quantity.increase.request'; alternative_capability := 'quantity:adjust';
      alternative_action_two := 'rework.quantity.increase.confirm'; alternative_capability_two := 'quantity:confirm';
    ELSIF OLD.status = 'pending_order_review' AND NEW.status = 'in_progress' THEN
      expected_action := 'rework.work_report.reject'; expected_capability := 'submission:audit';
      alternative_action := 'rework.quantity.increase.confirm'; alternative_capability := 'quantity:confirm';
    ELSIF OLD.status = 'pending_order_review' AND NEW.status = 'pending_quantity_adjustment_ie_review' THEN
      expected_action := 'rework.quantity.increase.confirm'; expected_capability := 'quantity:confirm';
    ELSIF OLD.status = 'pending_quantity_adjustment_ie_review' AND NEW.status IN ('in_progress','pending_order_review') THEN
      expected_action := 'rework.quantity.increase.ie_review'; expected_capability := 'process:review';
    ELSIF OLD.status = 'pending_order_review' AND NEW.status = 'pending_responsibility_determination' THEN
      expected_action := 'rework.whole_order.approve'; expected_capability := 'submission:audit';
    ELSIF OLD.status = 'pending_responsibility_determination' AND NEW.status = 'pending_responsibility_determination' THEN
      expected_action := 'rework.responsibility.draft'; expected_capability := 'responsibility:determine';
      alternative_action := 'rework.responsibility.transfer'; alternative_capability := 'responsibility:determine';
      alternative_action_two := 'rework.responsibility.takeover'; alternative_capability_two := 'responsibility:takeover';
      alternative_action_three := 'rework.responsibility.high_multiplier.confirm'; alternative_capability_three := 'responsibility:confirm_high_multiplier';
    ELSIF OLD.status = 'pending_responsibility_determination' AND NEW.status = 'pending_responsibility_action' THEN
      expected_action := 'rework.responsibility.finalize'; expected_capability := 'responsibility:determine';
    ELSIF OLD.status = 'pending_responsibility_action' AND NEW.status = 'pending_responsibility_determination' THEN
      expected_action := 'rework.own_factory_approval.reject'; expected_capability := 'own_factory:approve';
    ELSIF OLD.status IN ('draft', 'pending_process_configuration') AND NEW.status = 'cancelled' THEN
      expected_action := 'rework.cancel'; expected_capability := 'rework:initiate';
    ELSE
      RAISE EXCEPTION 'invalid rework order state transition: % to %', OLD.status, NEW.status USING ERRCODE = '23514';
    END IF;
    audit_actor_id := NEW.updated_by;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM operation_events event
    WHERE event.event_id = audit_event_id::uuid
      AND event.request_id = audit_request_id
      AND event.actor_id = audit_actor_id
      AND event.entity_type = 'rework_order'
      AND event.entity_id = NEW.rework_order_id::text
      AND (
        (event.action = expected_action AND (
          event.authorization_capability = expected_capability
          OR (expected_action = 'rework.work_report.submit' AND event.authorization_capability IN ('work:report','work:report_for_worker'))
        ))
        OR (alternative_action IS NOT NULL AND event.action = alternative_action AND event.authorization_capability = alternative_capability)
        OR (alternative_action_two IS NOT NULL AND event.action = alternative_action_two AND event.authorization_capability = alternative_capability_two)
        OR (alternative_action_three IS NOT NULL AND event.action = alternative_action_three AND event.authorization_capability = alternative_capability_three)
      )
      AND event.after_state @> jsonb_build_object(
        'reworkOrderId', NEW.rework_order_id, 'reworkNo', NEW.rework_no,
        'status', NEW.status, 'styleNo', NEW.style_no, 'orderNo', NEW.order_no,
        'merchandiserUserId', NEW.merchandiser_user_id,
        'processingFactory', CASE WHEN NEW.processing_factory_type IS NULL THEN NULL
          WHEN NEW.processing_factory_type = 'own_factory' THEN jsonb_build_object('type','own_factory')
          ELSE jsonb_build_object('type','supplier','supplierId',NEW.processing_factory_supplier_id,'supplierVersion',NEW.processing_factory_supplier_version) END,
        'problemPart', NEW.problem_part, 'problemDescription', NEW.problem_description,
        'reworkQuantity', NEW.rework_quantity, 'version', NEW.version
      )
      AND (NEW.status <> 'cancelled' OR (event.after_state ->> 'cancelReason' = NEW.cancel_reason AND NEW.cancelled_by = audit_actor_id))
  ) THEN
    RAISE EXCEPTION 'rework order audit event does not match the write' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;
