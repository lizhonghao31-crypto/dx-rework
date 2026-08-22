-- PR-05: append-only final quantity confirmation followed by independent IE review.
-- Worker reports stay immutable; wages materialize only from IE-approved settlement quantities.

ALTER TABLE rework_orders DROP CONSTRAINT rework_orders_status_check;
ALTER TABLE rework_orders ADD CONSTRAINT rework_orders_status_check CHECK (status IN (
  'draft','pending_process_configuration','pending_ie_review','pending_task_assignment',
  'in_progress','pending_order_review','pending_final_quantity_ie_review',
  'pending_quantity_adjustment_ie_review','pending_responsibility_determination',
  'pending_owner_signature','pending_responsibility_action','completed','cancelled','deleted'
));

ALTER TABLE rework_work_reports
  ADD COLUMN settlement_quantity numeric(18,2)
  CHECK(settlement_quantity IS NULL OR settlement_quantity>0);

ALTER TABLE rework_tail_completion_confirmations
  DROP CONSTRAINT rework_tail_completion_confirmations_rework_order_id_key;
ALTER TABLE rework_tail_completion_confirmations
  ADD COLUMN confirmation_version integer NOT NULL DEFAULT 1 CHECK(confirmation_version>0),
  ADD COLUMN workflow_stage text NOT NULL DEFAULT 'approved'
    CHECK(workflow_stage IN ('approved','pending_ie_review'));
ALTER TABLE rework_tail_completion_confirmations
  ADD CONSTRAINT rework_tail_completion_confirmations_order_version_key
  UNIQUE(rework_order_id,confirmation_version);

CREATE TABLE rework_tail_completion_quantities (
  confirmation_id uuid NOT NULL REFERENCES rework_tail_completion_confirmations(confirmation_id),
  configuration_item_id uuid NOT NULL REFERENCES rework_process_configuration_items(configuration_item_id),
  worker_reported_quantity numeric(18,2) NOT NULL CHECK(worker_reported_quantity>=0),
  tail_reported_quantity numeric(18,2) NOT NULL CHECK(tail_reported_quantity>=0),
  final_confirmed_quantity numeric(18,2) NOT NULL CHECK(final_confirmed_quantity>0),
  PRIMARY KEY(confirmation_id,configuration_item_id),
  CHECK(final_confirmed_quantity<=tail_reported_quantity),
  CHECK(worker_reported_quantity=trunc(worker_reported_quantity)),
  CHECK(tail_reported_quantity=trunc(tail_reported_quantity)),
  CHECK(final_confirmed_quantity=trunc(final_confirmed_quantity))
);

CREATE TABLE rework_tail_completion_reviews (
  completion_review_id uuid PRIMARY KEY,
  confirmation_id uuid NOT NULL UNIQUE REFERENCES rework_tail_completion_confirmations(confirmation_id),
  decision text NOT NULL CHECK(decision IN ('approved','rejected')),
  reviewed_by uuid NOT NULL REFERENCES app_users(id),
  reviewed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reason text CHECK(reason IS NULL OR length(btrim(reason)) BETWEEN 1 AND 500),
  operation_event_id uuid NOT NULL REFERENCES operation_events(event_id),
  request_id text NOT NULL CHECK(request_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  CHECK(decision='approved' OR reason IS NOT NULL)
);

CREATE OR REPLACE FUNCTION guard_rework_tail_completion_confirmation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.workflow_stage<>'pending_ie_review'
     OR NEW.confirmation_version<>COALESCE((
       SELECT max(existing.confirmation_version)+1
       FROM rework_tail_completion_confirmations existing
       WHERE existing.rework_order_id=NEW.rework_order_id
     ),1)
     OR EXISTS(
       SELECT 1 FROM rework_tail_completion_confirmations existing
       WHERE existing.rework_order_id=NEW.rework_order_id
         AND existing.workflow_stage='pending_ie_review'
         AND NOT EXISTS(
           SELECT 1 FROM rework_tail_completion_reviews review
           WHERE review.confirmation_id=existing.confirmation_id
         )
     )
     OR NOT EXISTS(
       SELECT 1 FROM rework_orders target
       JOIN operation_events event ON event.event_id=NEW.operation_event_id
       WHERE target.rework_order_id=NEW.rework_order_id
         AND target.status='pending_order_review'
         AND event.event_id=nullif(current_setting('dx_rework.rework_event_id',true),'')::uuid
         AND event.request_id=NEW.request_id
         AND event.request_id=nullif(current_setting('dx_rework.rework_request_id',true),'')
         AND event.action='rework.tail_completion.confirm'
         AND event.authorization_capability='submission:audit'
         AND event.actor_id=NEW.confirmed_by
         AND event.entity_type='rework_order'
         AND event.entity_id=NEW.rework_order_id::text
     )
  THEN RAISE EXCEPTION 'final quantity confirmation requires matching N05 audit and version' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION guard_rework_tail_completion_quantity()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_order_id uuid;
  worker_quantity numeric(18,2);
  tail_quantity numeric(18,2);
BEGIN
  SELECT confirmation.rework_order_id INTO target_order_id
  FROM rework_tail_completion_confirmations confirmation
  WHERE confirmation.confirmation_id=NEW.confirmation_id
    AND confirmation.workflow_stage='pending_ie_review'
    AND confirmation.operation_event_id=nullif(current_setting('dx_rework.rework_event_id',true),'')::uuid
    AND confirmation.request_id=nullif(current_setting('dx_rework.rework_request_id',true),'')
  FOR SHARE;
  IF target_order_id IS NULL THEN RAISE EXCEPTION 'quantity line lacks active final confirmation' USING ERRCODE='55000'; END IF;

  SELECT COALESCE(sum(report.actual_quantity),0) INTO worker_quantity
  FROM rework_work_reports report
  JOIN rework_process_configuration_items item ON item.configuration_item_id=report.configuration_item_id
  JOIN rework_process_configurations configuration ON configuration.configuration_id=item.configuration_id
  WHERE report.rework_order_id=target_order_id
    AND report.configuration_item_id=NEW.configuration_item_id
    AND item.execution_kind='worker' AND configuration.status='approved'
    AND report.status='submitted'
    AND NOT EXISTS(SELECT 1 FROM rework_work_report_rejections rejection WHERE rejection.work_report_id=report.work_report_id);

  SELECT COALESCE(sum(report.actual_quantity),0) INTO tail_quantity
  FROM rework_work_reports report
  JOIN rework_process_configuration_items item ON item.configuration_item_id=report.configuration_item_id
  WHERE report.rework_order_id=target_order_id
    AND item.execution_kind='tail_inspection'
    AND report.status='submitted'
    AND NOT EXISTS(SELECT 1 FROM rework_work_report_rejections rejection WHERE rejection.work_report_id=report.work_report_id);

  IF worker_quantity IS NULL OR NEW.worker_reported_quantity<>worker_quantity
     OR NEW.tail_reported_quantity<>tail_quantity
     OR NEW.final_confirmed_quantity>tail_quantity
  THEN RAISE EXCEPTION 'final quantity line does not match immutable worker/tail facts' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER rework_tail_completion_quantities_guard_insert
  BEFORE INSERT ON rework_tail_completion_quantities
  FOR EACH ROW EXECUTE FUNCTION guard_rework_tail_completion_quantity();
CREATE TRIGGER rework_tail_completion_quantities_no_update
  BEFORE UPDATE ON rework_tail_completion_quantities
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER rework_tail_completion_quantities_no_delete
  BEFORE DELETE ON rework_tail_completion_quantities
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER rework_tail_completion_quantities_no_truncate
  BEFORE TRUNCATE ON rework_tail_completion_quantities
  FOR EACH STATEMENT EXECUTE FUNCTION reject_operation_event_mutation();

CREATE OR REPLACE FUNCTION guard_rework_tail_completion_review()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(
    SELECT 1
    FROM rework_tail_completion_confirmations confirmation
    JOIN rework_orders target ON target.rework_order_id=confirmation.rework_order_id
    JOIN operation_events event ON event.event_id=NEW.operation_event_id
    WHERE confirmation.confirmation_id=NEW.confirmation_id
      AND confirmation.workflow_stage='pending_ie_review'
      AND target.status='pending_final_quantity_ie_review'
      AND event.event_id=nullif(current_setting('dx_rework.rework_event_id',true),'')::uuid
      AND event.request_id=NEW.request_id
      AND event.request_id=nullif(current_setting('dx_rework.rework_request_id',true),'')
      AND event.action='rework.final_quantity.ie_review'
      AND event.authorization_capability='process:review'
      AND event.actor_id=NEW.reviewed_by
      AND event.entity_type='rework_order'
      AND event.entity_id=target.rework_order_id::text
  ) THEN RAISE EXCEPTION 'IE final quantity review requires matching N06 audit' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER rework_tail_completion_reviews_guard_insert
  BEFORE INSERT ON rework_tail_completion_reviews
  FOR EACH ROW EXECUTE FUNCTION guard_rework_tail_completion_review();
CREATE TRIGGER rework_tail_completion_reviews_no_update
  BEFORE UPDATE ON rework_tail_completion_reviews
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER rework_tail_completion_reviews_no_delete
  BEFORE DELETE ON rework_tail_completion_reviews
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER rework_tail_completion_reviews_no_truncate
  BEFORE TRUNCATE ON rework_tail_completion_reviews
  FOR EACH STATEMENT EXECUTE FUNCTION reject_operation_event_mutation();

CREATE OR REPLACE FUNCTION rework_n06_event_matches(target_order_id uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS(
    SELECT 1
    FROM operation_events event
    JOIN rework_tail_completion_confirmations confirmation
      ON confirmation.rework_order_id=target_order_id
    JOIN rework_tail_completion_reviews review
      ON review.confirmation_id=confirmation.confirmation_id
     AND review.decision='approved'
     AND review.operation_event_id=event.event_id
     AND review.request_id=event.request_id
    WHERE event.event_id=nullif(current_setting('dx_rework.rework_event_id',true),'')::uuid
      AND event.request_id=nullif(current_setting('dx_rework.rework_request_id',true),'')
      AND event.action='rework.final_quantity.ie_review'
      AND event.authorization_capability='process:review'
      AND event.entity_type='rework_order'
      AND event.entity_id=target_order_id::text
  )
$$;

CREATE OR REPLACE FUNCTION guard_rework_work_report_final_amount()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW)-ARRAY['group_amount','settlement_quantity'])
       IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['group_amount','settlement_quantity'])
     OR OLD.group_amount<>0 OR NEW.group_amount<=0
     OR OLD.settlement_quantity IS NOT NULL OR NEW.settlement_quantity<=0
     OR NOT rework_n06_event_matches(OLD.rework_order_id)
  THEN RAISE EXCEPTION 'work report settlement quantity and amount require IE approval' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION guard_rework_work_report_share_final_amount()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_order_id uuid;
BEGIN
  SELECT report.rework_order_id INTO target_order_id
  FROM rework_work_reports report WHERE report.work_report_id=OLD.work_report_id;
  IF (to_jsonb(NEW)-'amount') IS DISTINCT FROM (to_jsonb(OLD)-'amount')
     OR OLD.amount<>0 OR NEW.amount<=0 OR target_order_id IS NULL
     OR NOT rework_n06_event_matches(target_order_id)
  THEN RAISE EXCEPTION 'work report share requires approved IE final quantity' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION guard_rework_order_review_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  unified_execution boolean;
BEGIN
  IF NOT EXISTS(
    SELECT 1 FROM rework_orders target
    WHERE target.rework_order_id=NEW.rework_order_id AND target.status='pending_final_quantity_ie_review'
  ) THEN RAISE EXCEPTION 'order is not pending IE final-quantity review' USING ERRCODE='23514'; END IF;

  SELECT configuration.unified_execution_required
  INTO unified_execution
  FROM rework_process_configurations configuration
  WHERE configuration.rework_order_id=NEW.rework_order_id
    AND configuration.status='approved'
  LIMIT 1;

  IF unified_execution IS NULL OR EXISTS(
    SELECT 1 FROM rework_process_configurations configuration
    JOIN rework_process_configuration_items item USING(configuration_id)
    WHERE configuration.rework_order_id=NEW.rework_order_id
      AND configuration.status='approved' AND item.unit_price IS NULL
  ) THEN RAISE EXCEPTION 'every IE-approved process requires a price' USING ERRCODE='23514'; END IF;

  IF unified_execution AND (
    (SELECT count(*) FROM rework_process_configurations configuration
      JOIN rework_process_configuration_items item USING(configuration_id)
      WHERE configuration.rework_order_id=NEW.rework_order_id
        AND configuration.status='approved'
        AND item.execution_kind='tail_inspection') <> 1
  ) THEN RAISE EXCEPTION 'unified execution requires exactly one tail-inspection process' USING ERRCODE='23514'; END IF;

  IF NOT EXISTS(
    SELECT 1
    FROM rework_tail_completion_confirmations confirmation
    JOIN rework_tail_completion_reviews review
      ON review.confirmation_id=confirmation.confirmation_id
     AND review.decision='approved'
    WHERE confirmation.rework_order_id=NEW.rework_order_id
      AND confirmation.workflow_stage='pending_ie_review'
      AND review.reviewed_by=NEW.reviewed_by
      AND review.operation_event_id=nullif(current_setting('dx_rework.rework_event_id',true),'')::uuid
      AND review.request_id=nullif(current_setting('dx_rework.rework_request_id',true),'')
  ) THEN RAISE EXCEPTION 'approved IE final-quantity review is required' USING ERRCODE='23514'; END IF;

  IF EXISTS(
    SELECT 1 FROM rework_work_tasks task
    WHERE task.rework_order_id=NEW.rework_order_id AND task.status='active'
      AND NOT EXISTS(
        SELECT 1 FROM rework_work_reports report
        WHERE report.work_task_id=task.work_task_id AND report.status='submitted'
          AND NOT EXISTS(
            SELECT 1 FROM rework_work_report_rejections rejection
            WHERE rejection.work_report_id=report.work_report_id
          )
      )
  ) THEN RAISE EXCEPTION 'every active execution task requires a valid report' USING ERRCODE='23514'; END IF;

  IF NOT unified_execution AND EXISTS(
    SELECT 1 FROM rework_tail_inspection_assignments assignment
    WHERE assignment.rework_order_id=NEW.rework_order_id AND assignment.revoked_at IS NULL
      AND NOT EXISTS(
        SELECT 1 FROM rework_tail_inspection_reports report
        WHERE report.tail_inspection_assignment_id=assignment.tail_inspection_assignment_id
          AND report.status='submitted'
      )
  ) THEN RAISE EXCEPTION 'every active legacy tail inspector requires a submitted count' USING ERRCODE='23514'; END IF;

  IF unified_execution AND EXISTS(
    WITH tail_total AS (
      SELECT COALESCE(sum(report.actual_quantity),0) AS quantity
      FROM rework_work_reports report
      JOIN rework_process_configuration_items item
        ON item.configuration_item_id=report.configuration_item_id
      WHERE report.rework_order_id=NEW.rework_order_id
        AND item.execution_kind='tail_inspection'
        AND report.status='submitted'
        AND NOT EXISTS(
          SELECT 1 FROM rework_work_report_rejections rejection
          WHERE rejection.work_report_id=report.work_report_id
        )
    )
    SELECT 1
    FROM rework_process_configurations configuration
    JOIN rework_process_configuration_items item ON item.configuration_id=configuration.configuration_id
    CROSS JOIN tail_total
    LEFT JOIN LATERAL (
      SELECT COALESCE(sum(report.actual_quantity),0) AS quantity
      FROM rework_work_reports report
      WHERE report.rework_order_id=NEW.rework_order_id
        AND report.configuration_item_id=item.configuration_item_id
        AND report.status='submitted'
        AND NOT EXISTS(
          SELECT 1 FROM rework_work_report_rejections rejection
          WHERE rejection.work_report_id=report.work_report_id
        )
    ) worker ON true
    WHERE configuration.rework_order_id=NEW.rework_order_id
      AND configuration.status='approved'
      AND item.execution_kind='worker'
      AND worker.quantity>tail_total.quantity
  ) THEN RAISE EXCEPTION 'worker count cannot exceed unified tail-inspection count' USING ERRCODE='23514'; END IF;

  IF NOT unified_execution AND EXISTS(
    SELECT 1
    FROM rework_process_configurations configuration
    JOIN rework_process_configuration_items item ON item.configuration_id=configuration.configuration_id
    LEFT JOIN LATERAL (
      SELECT COALESCE(sum(report.actual_quantity),0) AS quantity
      FROM rework_work_reports report
      WHERE report.rework_order_id=NEW.rework_order_id
        AND report.configuration_item_id=item.configuration_item_id
        AND report.status='submitted'
        AND NOT EXISTS(
          SELECT 1 FROM rework_work_report_rejections rejection
          WHERE rejection.work_report_id=report.work_report_id
        )
    ) worker ON true
    LEFT JOIN LATERAL (
      SELECT COALESCE(sum(report_item.inspected_quantity),0) AS quantity
      FROM rework_tail_inspection_report_items report_item
      JOIN rework_tail_inspection_reports report
        ON report.tail_inspection_report_id=report_item.tail_inspection_report_id
       AND report.status='submitted'
      JOIN rework_tail_inspection_assignments assignment
        ON assignment.tail_inspection_assignment_id=report.tail_inspection_assignment_id
       AND assignment.revoked_at IS NULL
      WHERE report.rework_order_id=NEW.rework_order_id
        AND report_item.configuration_item_id=item.configuration_item_id
    ) tail_checked ON true
    WHERE configuration.rework_order_id=NEW.rework_order_id
      AND configuration.status='approved'
      AND worker.quantity>tail_checked.quantity
  ) THEN RAISE EXCEPTION 'worker count cannot exceed legacy tail inspection count' USING ERRCODE='23514'; END IF;

  IF EXISTS(
    SELECT 1 FROM rework_work_reports report
    WHERE report.rework_order_id=NEW.rework_order_id AND report.status='submitted'
      AND NOT EXISTS(
        SELECT 1 FROM rework_work_report_rejections rejection
        WHERE rejection.work_report_id=report.work_report_id
      )
      AND report.group_amount<=0
  ) THEN RAISE EXCEPTION 'every valid report requires generated wages' USING ERRCODE='23514'; END IF;

  PERFORM require_whole_order_review_event(
    'rework.final_quantity.ie_review','process:review',NEW.rework_order_id,NEW.reviewed_by
  );
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION guard_rework_order_write()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE audit_event_id text:=nullif(current_setting('dx_rework.rework_event_id',true),''); audit_request_id text:=nullif(current_setting('dx_rework.rework_request_id',true),''); expected_action text; expected_capability text; alternative_action text:=NULL; alternative_capability text:=NULL; alternative_action_two text:=NULL; alternative_capability_two text:=NULL; alternative_action_three text:=NULL; alternative_capability_three text:=NULL; audit_actor_id uuid;
BEGIN
  IF audit_event_id IS NULL OR audit_request_id IS NULL OR audit_request_id !~ '^[A-Za-z0-9._:-]{1,128}$' THEN RAISE EXCEPTION 'rework order write requires trusted audit context' USING ERRCODE='55000'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.source_system='manual' THEN IF NEW.status<>'draft' OR NEW.version<>1 OR NEW.rework_no IS NOT NULL OR NEW.submitted_at IS NOT NULL OR NEW.created_by<>NEW.updated_by OR NEW.external_id IS NOT NULL OR NEW.external_idempotency_key IS NOT NULL OR NEW.erp_node_id IS NOT NULL THEN RAISE EXCEPTION 'new manual rework orders must start as an unsubmitted draft' USING ERRCODE='23514'; END IF; expected_action:='rework.draft.create'; expected_capability:='rework:initiate';
    ELSIF NEW.source_system IN ('erp','erp_emergency') THEN IF NEW.status<>'pending_process_configuration' OR NEW.version<>1 OR NEW.rework_no IS NULL OR NEW.submitted_at IS NULL OR NEW.created_by<>NEW.updated_by OR NEW.external_id IS NULL OR NEW.external_idempotency_key IS NULL OR NEW.erp_node_id IS NOT NULL OR NEW.style_no IS NULL OR NEW.merchandiser_user_id IS NULL OR NEW.processing_factory_type IS NULL OR NEW.problem_part IS NULL OR NEW.problem_description IS NULL OR NEW.rework_quantity IS NULL OR NEW.cancelled_at IS NOT NULL OR NEW.cancelled_by IS NOT NULL OR NEW.cancel_reason IS NOT NULL OR NEW.deleted_at IS NOT NULL OR NEW.deleted_by IS NOT NULL THEN RAISE EXCEPTION 'ERP rework orders must enter as a complete submitted order' USING ERRCODE='23514'; END IF; IF NEW.source_system='erp' AND NEW.created_by<>'00000000-0000-4000-8000-000000000016'::uuid THEN RAISE EXCEPTION 'ERP intake requires dedicated integration principal' USING ERRCODE='42501'; END IF; expected_action:='rework.submit'; expected_capability:=CASE NEW.source_system WHEN 'erp' THEN 'erp:integrate' ELSE 'erp:emergency_intake' END;
    ELSE RAISE EXCEPTION 'unsupported rework source system' USING ERRCODE='23514'; END IF; audit_actor_id:=NEW.created_by;
  ELSE
    IF NEW.rework_order_id IS DISTINCT FROM OLD.rework_order_id OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.source_system IS DISTINCT FROM OLD.source_system OR NEW.external_id IS DISTINCT FROM OLD.external_id OR NEW.external_idempotency_key IS DISTINCT FROM OLD.external_idempotency_key OR NEW.erp_node_id IS DISTINCT FROM OLD.erp_node_id OR NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'stable rework order identity and origin fields are immutable' USING ERRCODE='55000'; END IF;
    IF OLD.rework_no IS NOT NULL AND NEW.rework_no IS DISTINCT FROM OLD.rework_no THEN RAISE EXCEPTION 'allocated rework number is immutable' USING ERRCODE='55000'; END IF; IF OLD.submitted_at IS NOT NULL AND NEW.submitted_at IS DISTINCT FROM OLD.submitted_at THEN RAISE EXCEPTION 'first submission timestamp is immutable' USING ERRCODE='55000'; END IF; IF OLD.status='deleted' THEN RAISE EXCEPTION 'deleted rework orders are immutable' USING ERRCODE='55000'; END IF;
    IF NEW.status='deleted' THEN IF NEW.deleted_at IS NULL OR NEW.deleted_by IS NULL OR (to_jsonb(NEW)-ARRAY['status','deleted_at','deleted_by','updated_by','version','updated_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','deleted_at','deleted_by','updated_by','version','updated_at']) THEN RAISE EXCEPTION 'logical deletion may only update deletion metadata' USING ERRCODE='23514'; END IF; expected_action:='rework.delete'; expected_capability:='rework:delete';
    ELSIF EXISTS(SELECT 1 FROM operation_events event WHERE event.event_id=audit_event_id::uuid AND event.request_id=audit_request_id AND event.action='rework.attachments.supplement' AND event.entity_type='rework_order' AND event.entity_id=NEW.rework_order_id::text) THEN IF OLD.status IN ('completed','cancelled','deleted') OR (to_jsonb(NEW)-ARRAY['updated_by','version','updated_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['updated_by','version','updated_at']) THEN RAISE EXCEPTION 'supplemental images may only update active order audit metadata' USING ERRCODE='23514'; END IF; expected_action:='rework.attachments.supplement'; expected_capability:='rework:initiate';
    ELSE
      IF OLD.status='draft' AND NEW.status='draft' THEN expected_action:='rework.draft.update'; expected_capability:='rework:initiate';
      ELSIF OLD.status='draft' AND NEW.status='pending_process_configuration' THEN expected_action:='rework.submit'; expected_capability:='rework:initiate';
      ELSIF OLD.status='pending_process_configuration' AND NEW.status='draft' THEN expected_action:='rework.withdraw'; expected_capability:='rework:initiate';
      ELSIF OLD.status='pending_process_configuration' AND NEW.status IN ('pending_ie_review','pending_process_configuration') THEN expected_action:=CASE WHEN NEW.status='pending_process_configuration' THEN 'rework.process_configuration.save' ELSE 'rework.process_configuration.submit' END; expected_capability:='process:configure';
      ELSIF OLD.status='pending_ie_review' AND NEW.status IN ('pending_process_configuration','pending_task_assignment') THEN expected_action:='rework.process_configuration.review'; expected_capability:='process:review';
      ELSIF OLD.status='pending_task_assignment' AND NEW.status IN ('pending_ie_review','pending_task_assignment') THEN expected_action:=CASE WHEN NEW.status='pending_ie_review' THEN 'rework.process_configuration.submit' ELSE 'rework.process_configuration.save' END; expected_capability:='process:configure';
      ELSIF OLD.status='pending_task_assignment' AND NEW.status='in_progress' THEN expected_action:='rework.work_task.assignment_confirm'; expected_capability:='work:assign';
      ELSIF OLD.status='in_progress' AND NEW.status='in_progress' THEN expected_action:='rework.quantity.decrease'; expected_capability:='quantity:adjust';
      ELSIF OLD.status='in_progress' AND NEW.status='pending_order_review' THEN expected_action:='rework.work_report.submit'; expected_capability:='work:report'; alternative_action:='rework.tail_inspection.submit'; alternative_capability:='tail_inspection:report';
      ELSIF OLD.status='pending_order_review' AND NEW.status='pending_order_review' THEN expected_action:='rework.quantity.decrease'; expected_capability:='quantity:adjust'; alternative_action:='rework.quantity.increase.request'; alternative_capability:='quantity:adjust'; alternative_action_two:='rework.quantity.increase.confirm'; alternative_capability_two:='quantity:confirm';
      ELSIF OLD.status='pending_order_review' AND NEW.status='in_progress' THEN expected_action:='rework.work_report.reject'; expected_capability:='submission:audit'; alternative_action:='rework.quantity.increase.confirm'; alternative_capability:='quantity:confirm';
      ELSIF OLD.status='pending_order_review' AND NEW.status='pending_quantity_adjustment_ie_review' THEN expected_action:='rework.quantity.increase.confirm'; expected_capability:='quantity:confirm';
      ELSIF OLD.status='pending_quantity_adjustment_ie_review' AND NEW.status IN ('in_progress','pending_order_review') THEN expected_action:='rework.quantity.increase.ie_review'; expected_capability:='process:review';
      ELSIF OLD.status='pending_order_review' AND NEW.status='pending_final_quantity_ie_review' THEN expected_action:='rework.tail_completion.confirm'; expected_capability:='submission:audit';
      ELSIF OLD.status='pending_final_quantity_ie_review' AND NEW.status IN ('pending_order_review','pending_responsibility_determination') THEN expected_action:='rework.final_quantity.ie_review'; expected_capability:='process:review';
      ELSIF OLD.status='pending_responsibility_determination' AND NEW.status='pending_responsibility_determination' THEN expected_action:='rework.responsibility.draft'; expected_capability:='responsibility:determine'; alternative_action:='rework.responsibility.transfer'; alternative_capability:='responsibility:determine'; alternative_action_two:='rework.responsibility.takeover'; alternative_capability_two:='responsibility:takeover'; alternative_action_three:='rework.responsibility.high_multiplier.confirm'; alternative_capability_three:='responsibility:confirm_high_multiplier';
      ELSIF OLD.status='pending_responsibility_determination' AND NEW.status='pending_owner_signature' THEN expected_action:='rework.responsibility.submit_owner_signature'; expected_capability:='responsibility:determine'; ELSIF OLD.status='pending_responsibility_determination' AND NEW.status='pending_responsibility_action' THEN expected_action:='rework.responsibility.finalize'; expected_capability:='responsibility:determine'; ELSIF OLD.status='pending_owner_signature' AND NEW.status='pending_responsibility_determination' THEN expected_action:='rework.responsibility.owner_reject'; expected_capability:='responsibility:owner_sign'; ELSIF OLD.status='pending_owner_signature' AND NEW.status='completed' THEN expected_action:='rework.responsibility.owner_approve'; expected_capability:='responsibility:owner_sign'; ELSIF OLD.status='pending_responsibility_action' AND NEW.status='pending_responsibility_determination' THEN expected_action:='rework.own_factory_approval.reject'; expected_capability:='own_factory:approve'; alternative_action:='rework.external_responsibility.revision.approve'; alternative_capability:='external_responsibility:approve_revision'; ELSIF OLD.status='pending_responsibility_action' AND NEW.status='completed' THEN expected_action:='rework.responsibility.complete'; expected_capability:='external_responsibility:payables_confirm'; alternative_action:='rework.responsibility.complete'; alternative_capability:='own_factory:approve'; alternative_action_two:='rework.responsibility.complete'; alternative_capability_two:='responsibility:determine'; ELSIF OLD.status='completed' AND NEW.status='pending_responsibility_determination' THEN expected_action:='rework.external_responsibility.revision.approve'; expected_capability:='external_responsibility:approve_revision'; ELSIF OLD.status IN ('draft','pending_process_configuration') AND NEW.status='cancelled' THEN expected_action:='rework.cancel'; expected_capability:='rework:initiate'; ELSE RAISE EXCEPTION 'invalid rework order state transition: % to %',OLD.status,NEW.status USING ERRCODE='23514'; END IF;
    END IF; audit_actor_id:=NEW.updated_by;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM operation_events event WHERE event.event_id=audit_event_id::uuid AND event.request_id=audit_request_id AND event.actor_id=audit_actor_id AND event.entity_type='rework_order' AND event.entity_id=NEW.rework_order_id::text AND ((event.action=expected_action AND (event.authorization_capability=expected_capability OR (expected_action='rework.work_report.submit' AND event.authorization_capability IN ('work:report','work:report_for_worker','tail_inspection:report')))) OR (alternative_action IS NOT NULL AND event.action=alternative_action AND event.authorization_capability=alternative_capability) OR (alternative_action_two IS NOT NULL AND event.action=alternative_action_two AND event.authorization_capability=alternative_capability_two) OR (alternative_action_three IS NOT NULL AND event.action=alternative_action_three AND event.authorization_capability=alternative_capability_three)) AND event.after_state @> jsonb_build_object('reworkOrderId',NEW.rework_order_id,'reworkNo',NEW.rework_no,'status',NEW.status,'styleNo',NEW.style_no,'orderNo',NEW.order_no,'merchandiserUserId',NEW.merchandiser_user_id,'processingFactory',CASE WHEN NEW.processing_factory_type IS NULL THEN NULL WHEN NEW.processing_factory_type='own_factory' THEN jsonb_build_object('type','own_factory') ELSE jsonb_build_object('type','supplier','supplierId',NEW.processing_factory_supplier_id,'supplierVersion',NEW.processing_factory_supplier_version) END,'problemPart',NEW.problem_part,'problemDescription',NEW.problem_description,'reworkQuantity',NEW.rework_quantity,'version',NEW.version) AND (NEW.status<>'cancelled' OR (event.after_state->>'cancelReason'=NEW.cancel_reason AND NEW.cancelled_by=audit_actor_id)) AND (NEW.status<>'deleted' OR (event.after_state->>'deletedBy'=NEW.deleted_by::text AND NEW.deleted_by=audit_actor_id))) THEN RAISE EXCEPTION 'rework order audit event does not match the write' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;

-- Tail inspection is an execution/wage fact, not a repair responsibility line.
-- Keep the existing responsibility invariant, scoped to ordinary worker processes.
CREATE OR REPLACE FUNCTION validate_responsibility_version(version_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  determination rework_responsibility_determinations%ROWTYPE;
  approved_count integer;
  process_count integer;
  high_count integer;
BEGIN
  SELECT *
  INTO determination
  FROM rework_responsibility_determinations
  WHERE determination_id = version_id;

  IF determination.determination_id IS NULL THEN
    RETURN;
  END IF;

  SELECT count(*)
  INTO approved_count
  FROM rework_process_configurations configuration
  JOIN rework_process_configuration_items item USING(configuration_id)
  WHERE configuration.rework_order_id = determination.rework_order_id
    AND configuration.status = 'approved'
    AND item.execution_kind = 'worker';

  SELECT count(*)
  INTO process_count
  FROM rework_responsibility_processes
  WHERE determination_id = version_id;

  IF process_count <> approved_count THEN
    RAISE EXCEPTION 'responsibility processes must exactly cover approved configuration'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM rework_responsibility_processes process
    WHERE process.determination_id = version_id
      AND (
        NOT EXISTS (
          SELECT 1
          FROM rework_responsibility_allocations allocation
          WHERE allocation.determination_id = process.determination_id
            AND allocation.configuration_item_id = process.configuration_item_id
        )
        OR (
          SELECT sum(allocation.share_bps)
          FROM rework_responsibility_allocations allocation
          WHERE allocation.determination_id = process.determination_id
            AND allocation.configuration_item_id = process.configuration_item_id
        ) <> 10000
      )
  ) THEN
    RAISE EXCEPTION 'responsibility allocations must total 10000 bps'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM rework_responsibility_allocations allocation
    WHERE allocation.determination_id = version_id
      AND allocation.rounded_amount IS DISTINCT FROM (
        SELECT coalesce(sum(line.rounded_amount), 0)
        FROM rework_responsibility_amount_lines line
        WHERE line.determination_id = allocation.determination_id
          AND line.configuration_item_id = allocation.configuration_item_id
          AND line.responsibility_type = allocation.responsibility_type
      )
  ) THEN
    RAISE EXCEPTION 'allocation total differs from amount lines'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM rework_responsibility_processes process
    WHERE process.determination_id = version_id
      AND (
        process.responsibility_amount IS DISTINCT FROM (
          SELECT coalesce(sum(line.rounded_amount), 0)
          FROM rework_responsibility_amount_lines line
          WHERE line.determination_id = process.determination_id
            AND line.configuration_item_id = process.configuration_item_id
        )
        OR process.base_amount IS DISTINCT FROM (
          SELECT coalesce(sum(source.base_member_share_amount), 0)
          FROM (
            SELECT DISTINCT
                   line.work_report_id,
                   line.person_id,
                   line.base_member_share_amount
            FROM rework_responsibility_amount_lines line
            WHERE line.determination_id = process.determination_id
              AND line.configuration_item_id = process.configuration_item_id
          ) source
        )
      )
  ) THEN
    RAISE EXCEPTION 'process totals differ from source lines'
      USING ERRCODE = '23514';
  END IF;

  IF determination.calculation_total IS DISTINCT FROM (
    SELECT coalesce(sum(process.responsibility_amount), 0)
    FROM rework_responsibility_processes process
    WHERE process.determination_id = version_id
  ) THEN
    RAISE EXCEPTION 'determination total differs from processes'
      USING ERRCODE = '23514';
  END IF;

  SELECT count(*)
  INTO high_count
  FROM rework_responsibility_processes
  WHERE determination_id = version_id
    AND multiplier > 2;

  IF determination.stage = 'finalized'
     AND (
       (high_count = 0 AND determination.source_high_multiplier_confirmation_id IS NOT NULL)
       OR (high_count > 0 AND determination.source_high_multiplier_confirmation_id IS NULL)
     ) THEN
    RAISE EXCEPTION 'finalized high multiplier confirmation is invalid'
      USING ERRCODE = '23514';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION require_wage_materialization_event(
  target_review_id uuid
) RETURNS operation_events LANGUAGE plpgsql AS $$
DECLARE
  event_record operation_events%ROWTYPE;
  target_order_id uuid;
BEGIN
  SELECT rework_order_id INTO target_order_id
  FROM rework_order_reviews
  WHERE order_review_id=target_review_id;

  SELECT * INTO event_record
  FROM operation_events event
  WHERE event.event_id=nullif(
      current_setting('dx_rework.whole_order_review_event_id',true),''
    )::uuid
    AND event.request_id=nullif(
      current_setting('dx_rework.whole_order_review_request_id',true),''
    );

  IF target_order_id IS NULL
     OR event_record.event_id IS NULL
     OR event_record.entity_type<>'rework_order'
     OR event_record.entity_id<>target_order_id::text
     OR NOT (
       ((event_record.action='rework.whole_order.approve'
         AND event_record.authorization_capability='submission:audit')
        OR (event_record.action='rework.final_quantity.ie_review'
         AND event_record.authorization_capability='process:review'))
       OR (event_record.action='rework.tail_pricing.ie_approve'
           AND event_record.authorization_capability='process:review')
     ) THEN
    RAISE EXCEPTION 'wage materialization requires an approved wage-source event'
      USING ERRCODE='55000';
  END IF;
  RETURN event_record;
END;
$$;

CREATE OR REPLACE FUNCTION guard_wage_period_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  event_record operation_events%ROWTYPE;
BEGIN
  IF nullif(current_setting('dx_rework.wage_system_action',true),'')
       IS DISTINCT FROM 'materialize'
     OR NEW.status<>'pending_tail_review'
     OR NEW.period_version<>1
     OR NEW.source_item_count<>0
     OR NEW.person_count<>0
     OR NEW.original_total<>0
     OR NEW.adjustment_total<>0
     OR NEW.final_total<>0
     OR NEW.locked_by IS NOT NULL
     OR NEW.locked_at IS NOT NULL THEN
    RAISE EXCEPTION 'wage period must be created by materialization'
      USING ERRCODE='55000';
  END IF;
  SELECT * INTO event_record
  FROM operation_events
  WHERE event_id=NEW.created_operation_event_id
    AND request_id=NEW.created_request_id
    AND (
      ((action='rework.whole_order.approve'
        AND authorization_capability='submission:audit')
       OR (action='rework.final_quantity.ie_review'
        AND authorization_capability='process:review'))
      OR (action='rework.tail_pricing.ie_approve'
          AND authorization_capability='process:review')
    );
  IF event_record.event_id IS NULL THEN
    RAISE EXCEPTION 'wage period creation lacks reviewed source event'
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION guard_wage_item_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  source_record record;
BEGIN
  IF nullif(current_setting('dx_rework.wage_system_action',true),'')
       IS DISTINCT FROM 'materialize'
     OR NOT EXISTS(
       SELECT 1 FROM operation_events event
       WHERE event.event_id=NEW.operation_event_id
         AND event.request_id=NEW.operation_request_id
         AND (
      ((event.action='rework.whole_order.approve'
        AND event.authorization_capability='submission:audit')
       OR (event.action='rework.final_quantity.ie_review'
        AND event.authorization_capability='process:review'))
      OR (event.action='rework.tail_pricing.ie_approve'
          AND event.authorization_capability='process:review')
    )
     ) THEN
    RAISE EXCEPTION 'wage item must be materialized from reviewed work'
      USING ERRCODE='55000';
  END IF;
  SELECT
    report.rework_order_id,
    report.configuration_item_id,
    report.work_task_id,
    report.group_amount,
    COALESCE(report.settlement_quantity,report.actual_quantity) AS settlement_quantity,
    share.amount,
    member.display_name_snapshot,
    member.person_type_snapshot,
    task.assignment_mode,
    item.process_name,
    item.pricing_unit,
    item.unit_price,
    target_order.rework_no,
    target_order.style_no
  INTO source_record
  FROM rework_work_reports report
  JOIN rework_work_report_member_shares share
    ON share.work_report_id=report.work_report_id
   AND share.person_id=NEW.person_id
  JOIN rework_work_tasks task ON task.work_task_id=report.work_task_id
  JOIN rework_work_task_members member
    ON member.work_task_id=task.work_task_id
   AND member.person_id=NEW.person_id
  JOIN rework_process_configuration_items item
    ON item.configuration_item_id=report.configuration_item_id
  JOIN rework_orders target_order
    ON target_order.rework_order_id=report.rework_order_id
  WHERE report.work_report_id=NEW.work_report_id
    AND report.status='submitted'
    AND NOT EXISTS(
      SELECT 1 FROM rework_work_report_rejections rejection
      WHERE rejection.work_report_id=report.work_report_id
    );
  IF source_record.rework_order_id IS NULL
     OR NEW.rework_order_id<>source_record.rework_order_id
     OR NEW.configuration_item_id<>source_record.configuration_item_id
     OR NEW.work_task_id<>source_record.work_task_id
     OR NEW.group_amount<>source_record.group_amount
     OR NEW.actual_quantity_snapshot<>source_record.settlement_quantity
     OR NEW.exact_person_share<>source_record.amount
     OR NEW.person_name_snapshot<>source_record.display_name_snapshot
     OR NEW.person_type_snapshot<>source_record.person_type_snapshot
     OR NEW.assignment_mode<>source_record.assignment_mode
     OR NEW.process_name_snapshot<>source_record.process_name
     OR NEW.pricing_unit_snapshot<>source_record.pricing_unit
     OR NEW.unit_price_snapshot<>source_record.unit_price
     OR NEW.rework_no_snapshot<>source_record.rework_no
     OR NEW.style_no_snapshot<>source_record.style_no THEN
    RAISE EXCEPTION 'wage item snapshot does not match reviewed source'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION materialize_rework_wages_from_order_review_event_review_legacy(
  p_order_review_id uuid,
  p_event_id uuid,
  p_request_id text
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_review rework_order_reviews%ROWTYPE;
  v_source_event operation_events%ROWTYPE;
  v_report record;
  v_period_id uuid;
  v_period_status text;
  v_affected integer;
  v_allocated_total numeric(18,2);
BEGIN
  SELECT * INTO STRICT v_review
  FROM rework_order_reviews
  WHERE order_review_id=p_order_review_id;

  SELECT * INTO v_source_event
  FROM operation_events event
  WHERE event.event_id=p_event_id
    AND event.request_id=p_request_id
    AND event.actor_id=v_review.reviewed_by
    AND (
      ((event.action='rework.whole_order.approve'
        AND event.authorization_capability='submission:audit')
       OR (event.action='rework.final_quantity.ie_review'
        AND event.authorization_capability='process:review'))
      OR (event.action='rework.tail_pricing.ie_approve'
          AND event.authorization_capability='process:review')
    )
    AND event.entity_type='rework_order'
    AND event.entity_id=v_review.rework_order_id::text;

  IF v_source_event.event_id IS NULL THEN
    RAISE EXCEPTION 'wage materialization source event does not match order review'
      USING ERRCODE='55000';
  END IF;

  PERFORM set_config('dx_rework.wage_system_action','materialize',true);

  FOR v_report IN
    SELECT
      report.work_report_id,
      date_trunc(
        'month',
        report.completed_at AT TIME ZONE 'Asia/Singapore'
      )::date AS period_month
    FROM rework_work_reports report
    WHERE report.rework_order_id=v_review.rework_order_id
      AND report.status='submitted'
      AND NOT EXISTS(
        SELECT 1
        FROM rework_work_report_rejections rejection
        WHERE rejection.work_report_id=report.work_report_id
      )
    ORDER BY report.completed_at,report.work_report_id
  LOOP
    INSERT INTO rework_wage_periods(
      period_id,period_month,status,created_operation_event_id,created_request_id
    ) VALUES(
      gen_random_uuid(),v_report.period_month,'pending_tail_review',
      v_source_event.event_id,v_source_event.request_id
    )
    ON CONFLICT(period_month) DO NOTHING;

    SELECT period.period_id,period.status
    INTO STRICT v_period_id,v_period_status
    FROM rework_wage_periods period
    WHERE period.period_month=v_report.period_month
    FOR UPDATE;

    IF v_period_status='locked' THEN
      RAISE EXCEPTION 'cannot add wage source to locked period'
        USING ERRCODE='23514';
    END IF;

    WITH shares AS (
      SELECT
        share.person_id,
        share.amount,
        member.display_name_snapshot,
        member.person_type_snapshot,
        row_number() OVER(
          ORDER BY (share.amount-trunc(share.amount,2)) DESC,share.person_id
        )::integer AS remainder_rank,
        count(*) OVER()::integer AS member_count,
        (
          SELECT jsonb_agg(
            jsonb_build_object(
              'personId',member_snapshot.person_id,
              'displayName',member_snapshot.display_name_snapshot,
              'personType',member_snapshot.person_type_snapshot
            )
            ORDER BY member_snapshot.person_id
          )
          FROM rework_work_report_member_shares share_snapshot
          JOIN rework_work_task_members member_snapshot
            ON member_snapshot.work_task_id=report.work_task_id
           AND member_snapshot.person_id=share_snapshot.person_id
          WHERE share_snapshot.work_report_id=report.work_report_id
        ) AS member_snapshot,
        round(report.group_amount,2)-sum(trunc(share.amount,2)) OVER()
          AS cents_left,
        report.work_report_id,
        report.rework_order_id,
        report.configuration_item_id,
        report.work_task_id,
        COALESCE(report.settlement_quantity,report.actual_quantity) AS actual_quantity,
        report.completed_at,
        report.submitted_by,
        report.group_amount,
        task.assignment_mode,
        item.process_name,
        item.pricing_unit,
        item.unit_price,
        target_order.rework_no,
        target_order.style_no
      FROM rework_work_report_member_shares share
      JOIN rework_work_reports report
        ON report.work_report_id=share.work_report_id
      JOIN rework_work_tasks task
        ON task.work_task_id=report.work_task_id
      JOIN rework_work_task_members member
        ON member.work_task_id=task.work_task_id
       AND member.person_id=share.person_id
      JOIN rework_process_configuration_items item
        ON item.configuration_item_id=report.configuration_item_id
      JOIN rework_orders target_order
        ON target_order.rework_order_id=report.rework_order_id
      WHERE share.work_report_id=v_report.work_report_id
    )
    INSERT INTO rework_wage_items(
      wage_item_id,period_id,order_review_id,rework_order_id,
      configuration_item_id,work_task_id,work_report_id,person_id,
      person_name_snapshot,person_type_snapshot,rework_no_snapshot,
      style_no_snapshot,process_name_snapshot,pricing_unit_snapshot,
      unit_price_snapshot,actual_quantity_snapshot,assignment_mode,
      group_amount,exact_person_share,payable_amount,fractional_remainder,
      remainder_rank,member_count,member_snapshot,source_report_snapshot,
      operation_event_id,operation_request_id
    )
    SELECT
      gen_random_uuid(),v_period_id,p_order_review_id,rework_order_id,
      configuration_item_id,work_task_id,work_report_id,person_id,
      display_name_snapshot,person_type_snapshot,rework_no,style_no,
      process_name,pricing_unit,unit_price,actual_quantity,assignment_mode,
      group_amount,amount,
      trunc(amount,2)+CASE
        WHEN remainder_rank<=round(cents_left*100)::integer THEN 0.01
        ELSE 0
      END,
      amount-trunc(amount,2),remainder_rank,member_count,member_snapshot,
      jsonb_build_object(
        'workReportId',work_report_id,
        'workTaskId',work_task_id,
        'configurationItemId',configuration_item_id,
        'actualQuantity',actual_quantity,
        'completedAt',completed_at,
        'submittedBy',submitted_by,
        'groupAmount',group_amount
      ),
      v_source_event.event_id,v_source_event.request_id
    FROM shares
    ON CONFLICT(work_report_id,person_id) DO NOTHING;

    GET DIAGNOSTICS v_affected=ROW_COUNT;

    SELECT sum(item.payable_amount)
    INTO v_allocated_total
    FROM rework_wage_items item
    WHERE item.work_report_id=v_report.work_report_id;

    IF v_allocated_total IS DISTINCT FROM (
      SELECT round(report.group_amount,2)
      FROM rework_work_reports report
      WHERE report.work_report_id=v_report.work_report_id
    ) THEN
      RAISE EXCEPTION 'wage allocation does not equal rounded group amount'
        USING ERRCODE='23514';
    END IF;

    IF v_affected>0 THEN
      UPDATE rework_wage_periods period SET
        source_item_count=(
          SELECT count(*)
          FROM rework_wage_items item
          WHERE item.period_id=v_period_id
        ),
        person_count=(
          SELECT count(DISTINCT item.person_id)
          FROM rework_wage_items item
          WHERE item.period_id=v_period_id
        ),
        original_total=(
          SELECT COALESCE(sum(item.payable_amount),0)
          FROM rework_wage_items item
          WHERE item.period_id=v_period_id
        ),
        adjustment_total=(
          SELECT COALESCE(sum(adjustment.adjustment_amount),0)
          FROM rework_wage_adjustments adjustment
          WHERE adjustment.target_period_id=v_period_id
            AND adjustment.status='approved'
        ),
        final_total=(
          SELECT COALESCE(sum(item.payable_amount),0)
          FROM rework_wage_items item
          WHERE item.period_id=v_period_id
        )+(
          SELECT COALESCE(sum(adjustment.adjustment_amount),0)
          FROM rework_wage_adjustments adjustment
          WHERE adjustment.target_period_id=v_period_id
            AND adjustment.status='approved'
        ),
        status='pending_tail_review',
        period_version=period.period_version+1,
        updated_at=CURRENT_TIMESTAMP
      WHERE period.period_id=v_period_id;
    END IF;
  END LOOP;
END;
$$;
