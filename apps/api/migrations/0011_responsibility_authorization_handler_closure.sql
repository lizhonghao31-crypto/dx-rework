-- PR-09 S2: direct authorization, effective handler, transfer/takeover, and high-multiplier confirmation closure.

CREATE OR REPLACE FUNCTION responsibility_effective_handler(target_order_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(
    (
      SELECT event.to_user_id
      FROM rework_responsibility_handler_events event
      WHERE event.rework_order_id = target_order_id
      ORDER BY event.created_at DESC, event.handler_event_id DESC
      LIMIT 1
    ),
    (
      SELECT determination.handler_user_id
      FROM rework_responsibility_determinations determination
      WHERE determination.rework_order_id = target_order_id
        AND NOT EXISTS (
          SELECT 1
          FROM rework_responsibility_determinations successor
          WHERE successor.replaces_determination_id = determination.determination_id
        )
      ORDER BY determination.determination_version DESC
      LIMIT 1
    )
  )
$$;

CREATE OR REPLACE FUNCTION guard_determination_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  order_status text;
  event_actor uuid;
  event_action text;
  effective_handler uuid;
  predecessor rework_responsibility_determinations%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('responsibility:' || NEW.rework_order_id::text));

  SELECT status INTO order_status
  FROM rework_orders
  WHERE rework_order_id = NEW.rework_order_id
  FOR SHARE;

  IF order_status IS NULL THEN
    RAISE EXCEPTION 'rework order does not exist' USING ERRCODE = '23503';
  END IF;
  IF order_status <> 'pending_responsibility_determination' THEN
    RAISE EXCEPTION 'responsibility versions require pending_responsibility_determination'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM rework_order_reviews review
    WHERE review.order_review_id = NEW.source_order_review_id
      AND review.rework_order_id = NEW.rework_order_id
  ) THEN
    RAISE EXCEPTION 'source review must belong to order' USING ERRCODE = '23514';
  END IF;

  IF (NEW.replaces_determination_id IS NULL AND NEW.determination_version <> 1)
     OR (
       NEW.replaces_determination_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1
         FROM rework_responsibility_determinations previous
         WHERE previous.determination_id = NEW.replaces_determination_id
           AND previous.rework_order_id = NEW.rework_order_id
           AND previous.determination_version + 1 = NEW.determination_version
       )
     ) THEN
    RAISE EXCEPTION 'invalid determination version chain' USING ERRCODE = '23514';
  END IF;

  SELECT actor_id, action
  INTO event_actor, event_action
  FROM operation_events
  WHERE event_id = NEW.operation_event_id
    AND request_id = NEW.request_id;

  PERFORM require_responsibility_event(
    NEW.operation_event_id,
    NEW.request_id,
    NEW.rework_order_id,
    NEW.created_by
  );

  IF event_actor IS DISTINCT FROM NEW.created_by THEN
    RAISE EXCEPTION 'determination creator must match operation actor' USING ERRCODE = '55000';
  END IF;

  effective_handler := responsibility_effective_handler(NEW.rework_order_id);

  IF NEW.stage = 'draft' THEN
    IF event_action NOT IN ('rework.responsibility.draft', 'rework.responsibility.reopen') THEN
      RAISE EXCEPTION 'draft determination requires draft or reopen event' USING ERRCODE = '55000';
    END IF;
    IF NOT responsibility_can_determine(event_actor, NEW.rework_order_id) THEN
      RAISE EXCEPTION 'actor is not authorized to determine responsibility' USING ERRCODE = '42501';
    END IF;
    IF effective_handler IS NULL THEN
      IF NEW.handler_user_id IS DISTINCT FROM event_actor THEN
        RAISE EXCEPTION 'first draft handler must be the authorized actor' USING ERRCODE = '42501';
      END IF;
    ELSIF event_actor IS DISTINCT FROM effective_handler
       OR NEW.handler_user_id IS DISTINCT FROM effective_handler THEN
      RAISE EXCEPTION 'only the effective handler may create the next draft' USING ERRCODE = '42501';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM rework_responsibility_determinations current_draft
      WHERE current_draft.rework_order_id = NEW.rework_order_id
        AND current_draft.stage = 'draft'
        AND NOT EXISTS (
          SELECT 1
          FROM rework_responsibility_determinations successor
          WHERE successor.replaces_determination_id = current_draft.determination_id
        )
        AND current_draft.determination_id IS DISTINCT FROM NEW.replaces_determination_id
    ) THEN
      RAISE EXCEPTION 'order already has a current draft' USING ERRCODE = '23505';
    END IF;
  ELSE
    IF event_action <> 'rework.responsibility.finalize' THEN
      RAISE EXCEPTION 'finalized determination requires finalize event' USING ERRCODE = '55000';
    END IF;
    SELECT *
    INTO predecessor
    FROM rework_responsibility_determinations
    WHERE determination_id = NEW.replaces_determination_id;

    IF predecessor.determination_id IS NULL
       OR predecessor.stage <> 'draft'
       OR predecessor.rework_order_id <> NEW.rework_order_id THEN
      RAISE EXCEPTION 'finalized version must directly replace the current draft'
        USING ERRCODE = '23514';
    END IF;
    IF effective_handler IS NULL
       OR event_actor IS DISTINCT FROM effective_handler
       OR NEW.handler_user_id IS DISTINCT FROM effective_handler
       OR NOT responsibility_can_determine(event_actor, NEW.rework_order_id) THEN
      RAISE EXCEPTION 'only the effective handler may finalize responsibility'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION guard_responsibility_confirmation_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  determination rework_responsibility_determinations%ROWTYPE;
  order_status text;
  current_leaf uuid;
  expected_snapshot jsonb;
BEGIN
  SELECT *
  INTO determination
  FROM rework_responsibility_determinations
  WHERE determination_id = NEW.determination_id
  FOR SHARE;

  IF determination.determination_id IS NULL THEN
    RAISE EXCEPTION 'responsibility determination does not exist' USING ERRCODE = '23503';
  END IF;

  SELECT status INTO order_status
  FROM rework_orders
  WHERE rework_order_id = determination.rework_order_id
  FOR SHARE;

  SELECT leaf.determination_id
  INTO current_leaf
  FROM rework_responsibility_determinations leaf
  WHERE leaf.rework_order_id = determination.rework_order_id
    AND NOT EXISTS (
      SELECT 1
      FROM rework_responsibility_determinations successor
      WHERE successor.replaces_determination_id = leaf.determination_id
    );

  IF order_status <> 'pending_responsibility_determination'
     OR determination.stage <> 'draft'
     OR current_leaf IS DISTINCT FROM determination.determination_id THEN
    RAISE EXCEPTION 'only the current pending draft may be confirmed' USING ERRCODE = '23514';
  END IF;

  IF NOT responsibility_actor_has_direct_role(
    NEW.confirmed_by,
    'responsibility:confirm_high_multiplier',
    ARRAY['owner_group']
  ) THEN
    RAISE EXCEPTION 'high multiplier confirmation requires a direct active owner'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.confirmed_by = determination.created_by THEN
    RAISE EXCEPTION 'high multiplier submitter cannot confirm the same version'
      USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM rework_responsibility_processes process
    WHERE process.determination_id = NEW.determination_id
      AND process.multiplier > 2
  ) THEN
    RAISE EXCEPTION 'determination has no high multiplier process' USING ERRCODE = '23514';
  END IF;

  SELECT jsonb_build_object(
    'determinationId', determination.determination_id,
    'determinationVersion', determination.determination_version,
    'submittedBy', determination.created_by,
    'handlerUserId', responsibility_effective_handler(determination.rework_order_id),
    'processes', COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'configurationItemId', process.configuration_item_id,
          'multiplier', process.multiplier::text,
          'highMultiplierReason', process.high_multiplier_reason
        )
        ORDER BY process.configuration_item_id
      ) FILTER (WHERE process.configuration_item_id IS NOT NULL),
      '[]'::jsonb
    )
  )
  INTO expected_snapshot
  FROM rework_responsibility_processes process
  WHERE process.determination_id = determination.determination_id
    AND process.multiplier > 2;

  IF NEW.confirmation_snapshot IS DISTINCT FROM expected_snapshot THEN
    RAISE EXCEPTION 'high multiplier confirmation snapshot does not match the draft'
      USING ERRCODE = '23514';
  END IF;

  PERFORM require_responsibility_event(
    NEW.operation_event_id,
    NEW.request_id,
    determination.rework_order_id,
    NEW.confirmed_by
  );

  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION guard_responsibility_handler_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  order_status text;
  current_leaf uuid;
  current_handler uuid;
  event_action text;
BEGIN
  SELECT status INTO order_status
  FROM rework_orders
  WHERE rework_order_id = NEW.rework_order_id
  FOR SHARE;

  IF order_status <> 'pending_responsibility_determination' THEN
    RAISE EXCEPTION 'handler changes require pending responsibility determination'
      USING ERRCODE = '23514';
  END IF;

  SELECT leaf.determination_id
  INTO current_leaf
  FROM rework_responsibility_determinations leaf
  WHERE leaf.rework_order_id = NEW.rework_order_id
    AND NOT EXISTS (
      SELECT 1
      FROM rework_responsibility_determinations successor
      WHERE successor.replaces_determination_id = leaf.determination_id
    );

  IF NEW.determination_id IS NOT NULL
     AND NEW.determination_id IS DISTINCT FROM current_leaf THEN
    RAISE EXCEPTION 'handler event must reference the current determination leaf'
      USING ERRCODE = '23514';
  END IF;

  current_handler := responsibility_effective_handler(NEW.rework_order_id);

  IF NEW.from_user_id IS DISTINCT FROM current_handler THEN
    RAISE EXCEPTION 'handler event from_user_id must match the effective handler'
      USING ERRCODE = '23514';
  END IF;

  SELECT action INTO event_action
  FROM operation_events
  WHERE event_id = NEW.operation_event_id
    AND request_id = NEW.request_id;

  PERFORM require_responsibility_event(
    NEW.operation_event_id,
    NEW.request_id,
    NEW.rework_order_id,
    NEW.acted_by
  );

  IF NEW.event_type = 'transferred' THEN
    IF event_action <> 'rework.responsibility.transfer'
       OR current_handler IS NULL
       OR NEW.acted_by IS DISTINCT FROM current_handler
       OR NOT responsibility_can_determine(NEW.acted_by, NEW.rework_order_id)
       OR NOT responsibility_can_determine(NEW.to_user_id, NEW.rework_order_id) THEN
      RAISE EXCEPTION 'responsibility transfer is not authorized' USING ERRCODE = '42501';
    END IF;
  ELSIF NEW.event_type = 'taken_over' THEN
    IF event_action <> 'rework.responsibility.takeover'
       OR NEW.to_user_id IS DISTINCT FROM NEW.acted_by
       OR NOT responsibility_actor_has_direct_role(
         NEW.acted_by,
         'responsibility:takeover',
         ARRAY['owner_group']
       ) THEN
      RAISE EXCEPTION 'responsibility takeover requires a direct active owner'
        USING ERRCODE = '42501';
    END IF;
  ELSE
    IF event_action <> 'rework.responsibility.transfer'
       OR current_handler IS NOT NULL
       OR NEW.from_user_id IS NOT NULL
       OR NEW.to_user_id IS DISTINCT FROM NEW.acted_by
       OR NOT responsibility_can_determine(NEW.acted_by, NEW.rework_order_id) THEN
      RAISE EXCEPTION 'initial responsibility handler assignment is not authorized'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  IF NEW.to_user_id IS NOT DISTINCT FROM current_handler THEN
    RAISE EXCEPTION 'handler change must select a different handler' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS confirmation_insert
  ON rework_responsibility_high_multiplier_confirmations;
CREATE TRIGGER confirmation_insert
BEFORE INSERT ON rework_responsibility_high_multiplier_confirmations
FOR EACH ROW
EXECUTE FUNCTION guard_responsibility_confirmation_insert();

DROP TRIGGER IF EXISTS handler_insert
  ON rework_responsibility_handler_events;
CREATE TRIGGER handler_insert
BEFORE INSERT ON rework_responsibility_handler_events
FOR EACH ROW
EXECUTE FUNCTION guard_responsibility_handler_insert();

CREATE OR REPLACE FUNCTION validate_finalized_responsibility_copy()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  source_confirmation rework_responsibility_high_multiplier_confirmations%ROWTYPE;
BEGIN
  IF NEW.stage <> 'finalized' THEN
    RETURN NULL;
  END IF;

  IF EXISTS (
    (
      SELECT configuration_item_id, process_name_snapshot, pricing_unit_snapshot,
             multiplier, high_multiplier_reason, base_amount, responsibility_amount
      FROM rework_responsibility_processes
      WHERE determination_id = NEW.determination_id
      EXCEPT
      SELECT configuration_item_id, process_name_snapshot, pricing_unit_snapshot,
             multiplier, high_multiplier_reason, base_amount, responsibility_amount
      FROM rework_responsibility_processes
      WHERE determination_id = NEW.replaces_determination_id
    )
    UNION ALL
    (
      SELECT configuration_item_id, process_name_snapshot, pricing_unit_snapshot,
             multiplier, high_multiplier_reason, base_amount, responsibility_amount
      FROM rework_responsibility_processes
      WHERE determination_id = NEW.replaces_determination_id
      EXCEPT
      SELECT configuration_item_id, process_name_snapshot, pricing_unit_snapshot,
             multiplier, high_multiplier_reason, base_amount, responsibility_amount
      FROM rework_responsibility_processes
      WHERE determination_id = NEW.determination_id
    )
  ) THEN
    RAISE EXCEPTION 'finalized version must copy draft processes' USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    (
      SELECT configuration_item_id, responsibility_type, share_bps, rounded_amount
      FROM rework_responsibility_allocations
      WHERE determination_id = NEW.determination_id
      EXCEPT
      SELECT configuration_item_id, responsibility_type, share_bps, rounded_amount
      FROM rework_responsibility_allocations
      WHERE determination_id = NEW.replaces_determination_id
    )
    UNION ALL
    (
      SELECT configuration_item_id, responsibility_type, share_bps, rounded_amount
      FROM rework_responsibility_allocations
      WHERE determination_id = NEW.replaces_determination_id
      EXCEPT
      SELECT configuration_item_id, responsibility_type, share_bps, rounded_amount
      FROM rework_responsibility_allocations
      WHERE determination_id = NEW.determination_id
    )
  ) THEN
    RAISE EXCEPTION 'finalized version must copy draft allocations' USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    (
      SELECT configuration_item_id, work_report_id, person_id, responsibility_type,
             base_member_share_amount, multiplier, share_bps, unrounded_amount,
             rounded_amount, rounding_rule, worker_display_name_snapshot,
             task_mode_snapshot, member_snapshot, report_snapshot
      FROM rework_responsibility_amount_lines
      WHERE determination_id = NEW.determination_id
      EXCEPT
      SELECT configuration_item_id, work_report_id, person_id, responsibility_type,
             base_member_share_amount, multiplier, share_bps, unrounded_amount,
             rounded_amount, rounding_rule, worker_display_name_snapshot,
             task_mode_snapshot, member_snapshot, report_snapshot
      FROM rework_responsibility_amount_lines
      WHERE determination_id = NEW.replaces_determination_id
    )
    UNION ALL
    (
      SELECT configuration_item_id, work_report_id, person_id, responsibility_type,
             base_member_share_amount, multiplier, share_bps, unrounded_amount,
             rounded_amount, rounding_rule, worker_display_name_snapshot,
             task_mode_snapshot, member_snapshot, report_snapshot
      FROM rework_responsibility_amount_lines
      WHERE determination_id = NEW.replaces_determination_id
      EXCEPT
      SELECT configuration_item_id, work_report_id, person_id, responsibility_type,
             base_member_share_amount, multiplier, share_bps, unrounded_amount,
             rounded_amount, rounding_rule, worker_display_name_snapshot,
             task_mode_snapshot, member_snapshot, report_snapshot
      FROM rework_responsibility_amount_lines
      WHERE determination_id = NEW.determination_id
    )
  ) THEN
    RAISE EXCEPTION 'finalized version must copy draft amount lines' USING ERRCODE = '23514';
  END IF;

  IF NEW.source_high_multiplier_confirmation_id IS NOT NULL THEN
    SELECT *
    INTO source_confirmation
    FROM rework_responsibility_high_multiplier_confirmations
    WHERE confirmation_id = NEW.source_high_multiplier_confirmation_id;

    IF source_confirmation.confirmation_id IS NULL
       OR source_confirmation.determination_id IS DISTINCT FROM NEW.replaces_determination_id THEN
      RAISE EXCEPTION 'finalized confirmation must belong to the predecessor draft'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS finalized_copy_complete
  ON rework_responsibility_determinations;
CREATE CONSTRAINT TRIGGER finalized_copy_complete
AFTER INSERT ON rework_responsibility_determinations
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION validate_finalized_responsibility_copy();

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
      RAISE EXCEPTION 'new manual rework orders must start as an unsubmitted draft'
        USING ERRCODE = '23514';
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
      RAISE EXCEPTION 'stable rework order identity and origin fields are immutable'
        USING ERRCODE = '55000';
    END IF;
    IF OLD.rework_no IS NOT NULL AND NEW.rework_no IS DISTINCT FROM OLD.rework_no THEN
      RAISE EXCEPTION 'allocated rework number is immutable' USING ERRCODE = '55000';
    END IF;
    IF OLD.submitted_at IS NOT NULL
       AND NEW.submitted_at IS DISTINCT FROM OLD.submitted_at THEN
      RAISE EXCEPTION 'first submission timestamp is immutable' USING ERRCODE = '55000';
    END IF;

    IF OLD.status = 'draft' AND NEW.status = 'draft' THEN
      expected_action := 'rework.draft.update'; expected_capability := 'rework:initiate';
    ELSIF OLD.status = 'draft' AND NEW.status = 'pending_process_configuration' THEN
      expected_action := 'rework.submit'; expected_capability := 'rework:initiate';
    ELSIF OLD.status = 'pending_process_configuration' AND NEW.status = 'draft' THEN
      expected_action := 'rework.withdraw'; expected_capability := 'rework:initiate';
    ELSIF OLD.status = 'pending_process_configuration' AND NEW.status = 'pending_ie_review' THEN
      expected_action := 'rework.process_configuration.submit'; expected_capability := 'process:configure';
    ELSIF OLD.status = 'pending_process_configuration' AND NEW.status = 'pending_process_configuration' THEN
      expected_action := 'rework.process_configuration.save'; expected_capability := 'process:configure';
    ELSIF OLD.status = 'pending_ie_review' AND NEW.status = 'pending_process_configuration' THEN
      expected_action := 'rework.process_configuration.review'; expected_capability := 'process:review';
    ELSIF OLD.status = 'pending_ie_review' AND NEW.status = 'pending_task_assignment' THEN
      expected_action := 'rework.process_configuration.review'; expected_capability := 'process:review';
    ELSIF OLD.status = 'pending_task_assignment' AND NEW.status = 'pending_ie_review' THEN
      expected_action := 'rework.process_configuration.submit'; expected_capability := 'process:configure';
    ELSIF OLD.status = 'pending_task_assignment' AND NEW.status = 'pending_task_assignment' THEN
      expected_action := 'rework.process_configuration.save'; expected_capability := 'process:configure';
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
    ELSIF OLD.status = 'pending_order_review'
       AND NEW.status = 'pending_quantity_adjustment_ie_review' THEN
      expected_action := 'rework.quantity.increase.confirm'; expected_capability := 'quantity:confirm';
    ELSIF OLD.status = 'pending_quantity_adjustment_ie_review'
       AND NEW.status = 'in_progress' THEN
      expected_action := 'rework.quantity.increase.ie_review'; expected_capability := 'process:review';
    ELSIF OLD.status = 'pending_quantity_adjustment_ie_review'
       AND NEW.status = 'pending_order_review' THEN
      expected_action := 'rework.quantity.increase.ie_review'; expected_capability := 'process:review';
    ELSIF OLD.status = 'pending_order_review'
       AND NEW.status = 'pending_responsibility_determination' THEN
      expected_action := 'rework.whole_order.approve'; expected_capability := 'submission:audit';
    ELSIF OLD.status = 'pending_responsibility_determination'
       AND NEW.status = 'pending_responsibility_determination' THEN
      expected_action := 'rework.responsibility.draft';
      expected_capability := 'responsibility:determine';
      alternative_action := 'rework.responsibility.transfer';
      alternative_capability := 'responsibility:determine';
      alternative_action_two := 'rework.responsibility.takeover';
      alternative_capability_two := 'responsibility:takeover';
      alternative_action_three := 'rework.responsibility.high_multiplier.confirm';
      alternative_capability_three := 'responsibility:confirm_high_multiplier';
    ELSIF OLD.status = 'pending_responsibility_determination'
       AND NEW.status = 'pending_responsibility_action' THEN
      expected_action := 'rework.responsibility.finalize';
      expected_capability := 'responsibility:determine';
    ELSIF OLD.status IN ('draft', 'pending_process_configuration')
       AND NEW.status = 'cancelled' THEN
      expected_action := 'rework.cancel'; expected_capability := 'rework:initiate';
    ELSE
      RAISE EXCEPTION 'invalid rework order state transition: % to %', OLD.status, NEW.status
        USING ERRCODE = '23514';
    END IF;
    audit_actor_id := NEW.updated_by;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM operation_events event
    WHERE event.event_id = audit_event_id::uuid
      AND event.request_id = audit_request_id
      AND event.actor_id = audit_actor_id
      AND event.entity_type = 'rework_order'
      AND event.entity_id = NEW.rework_order_id::text
      AND (
        (
          event.action = expected_action
          AND (
            event.authorization_capability = expected_capability
            OR (
              expected_action = 'rework.work_report.submit'
              AND event.authorization_capability IN ('work:report', 'work:report_for_worker')
            )
          )
        )
        OR (
          alternative_action IS NOT NULL
          AND event.action = alternative_action
          AND event.authorization_capability = alternative_capability
        )
        OR (
          alternative_action_two IS NOT NULL
          AND event.action = alternative_action_two
          AND event.authorization_capability = alternative_capability_two
        )
        OR (
          alternative_action_three IS NOT NULL
          AND event.action = alternative_action_three
          AND event.authorization_capability = alternative_capability_three
        )
      )
      AND event.after_state @> jsonb_build_object(
        'reworkOrderId', NEW.rework_order_id,
        'reworkNo', NEW.rework_no,
        'status', NEW.status,
        'styleNo', NEW.style_no,
        'orderNo', NEW.order_no,
        'merchandiserUserId', NEW.merchandiser_user_id,
        'processingFactory',
          CASE
            WHEN NEW.processing_factory_type IS NULL THEN NULL
            WHEN NEW.processing_factory_type = 'own_factory'
              THEN jsonb_build_object('type', 'own_factory')
            ELSE jsonb_build_object(
              'type', 'supplier',
              'supplierId', NEW.processing_factory_supplier_id,
              'supplierVersion', NEW.processing_factory_supplier_version
            )
          END,
        'problemPart', NEW.problem_part,
        'problemDescription', NEW.problem_description,
        'reworkQuantity', NEW.rework_quantity,
        'version', NEW.version
      )
      AND (
        NEW.status <> 'cancelled'
        OR (
          event.after_state ->> 'cancelReason' = NEW.cancel_reason
          AND NEW.cancelled_by = audit_actor_id
        )
      )
  ) THEN
    RAISE EXCEPTION 'rework order audit event does not match the write'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END
$$;
