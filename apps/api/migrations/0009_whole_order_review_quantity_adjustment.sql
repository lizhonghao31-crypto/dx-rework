ALTER TABLE rework_orders DROP CONSTRAINT rework_orders_status_check;
ALTER TABLE rework_orders ADD CONSTRAINT rework_orders_status_check CHECK (status IN (
  'draft','pending_process_configuration','pending_ie_review','pending_task_assignment',
  'in_progress','pending_order_review','pending_quantity_adjustment_ie_review',
  'pending_responsibility_determination','cancelled'
));

ALTER TABLE rework_work_reports
  ADD COLUMN resubmits_work_report_id uuid REFERENCES rework_work_reports(work_report_id);
CREATE UNIQUE INDEX rework_work_reports_one_resubmission_idx
  ON rework_work_reports(resubmits_work_report_id)
  WHERE resubmits_work_report_id IS NOT NULL;

CREATE TABLE rework_work_report_rejections (
  report_rejection_id uuid PRIMARY KEY,
  work_report_id uuid NOT NULL UNIQUE REFERENCES rework_work_reports(work_report_id),
  rework_order_id uuid NOT NULL REFERENCES rework_orders(rework_order_id),
  rejected_person_id uuid REFERENCES business_people(person_id),
  rejected_by uuid NOT NULL REFERENCES app_users(id),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  report_snapshot jsonb NOT NULL,
  rejected_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX rework_work_report_rejections_order_idx
  ON rework_work_report_rejections(rework_order_id,rejected_at DESC);

CREATE TABLE rework_process_quantity_adjustments (
  adjustment_id uuid PRIMARY KEY,
  rework_order_id uuid NOT NULL REFERENCES rework_orders(rework_order_id),
  configuration_item_id uuid NOT NULL REFERENCES rework_process_configuration_items(configuration_item_id),
  adjustment_version integer NOT NULL CHECK (adjustment_version > 0),
  adjustment_kind text NOT NULL CHECK (adjustment_kind IN ('decrease','increase')),
  status text NOT NULL CHECK (status IN ('effective','pending_merchandiser_confirmation','pending_ie_review','rejected','expired')),
  previous_planned_quantity numeric(14,2) NOT NULL CHECK (previous_planned_quantity > 0),
  requested_planned_quantity numeric(14,2) NOT NULL CHECK (requested_planned_quantity > 0),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  requires_ie_review boolean NOT NULL DEFAULT false,
  expires_at timestamptz,
  requested_by uuid NOT NULL REFERENCES app_users(id),
  requested_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  confirmed_by uuid REFERENCES app_users(id),
  confirmed_at timestamptz,
  actual_cut_quantity numeric(14,2),
  actual_return_quantity numeric(14,2),
  allowed_maximum_quantity numeric(14,2),
  confirmation_reason text,
  reviewed_by uuid REFERENCES app_users(id),
  reviewed_at timestamptz,
  review_reason text,
  UNIQUE(configuration_item_id,adjustment_version),
  CHECK (
    (adjustment_kind='decrease' AND requested_planned_quantity < previous_planned_quantity
      AND status='effective' AND requires_ie_review=false AND expires_at IS NULL)
    OR
    (adjustment_kind='increase' AND requested_planned_quantity > previous_planned_quantity)
  ),
  CHECK (expires_at IS NULL OR expires_at > requested_at),
  CHECK (confirmation_reason IS NULL OR length(btrim(confirmation_reason)) BETWEEN 1 AND 500),
  CHECK (review_reason IS NULL OR length(btrim(review_reason)) BETWEEN 1 AND 500)
);
CREATE INDEX rework_process_quantity_adjustments_order_idx
  ON rework_process_quantity_adjustments(rework_order_id,configuration_item_id,adjustment_version DESC);

CREATE TABLE rework_order_reviews (
  order_review_id uuid PRIMARY KEY,
  rework_order_id uuid NOT NULL UNIQUE REFERENCES rework_orders(rework_order_id),
  reviewed_by uuid NOT NULL REFERENCES app_users(id),
  reviewed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  review_snapshot jsonb NOT NULL
);

-- The policy catalog is append-only. PR-08 adds only the order-merchandiser
-- confirmation capability and immediately restores the immutable catalog guards.
DROP TRIGGER capability_catalog_no_insert ON capability_catalog;
DROP TRIGGER role_capabilities_no_insert ON role_capabilities;
INSERT INTO capability_catalog(capability,display_name,description) VALUES
  ('quantity:confirm','确认计划增加','订单跟单确认实裁、回货与计划增加上限')
ON CONFLICT (capability) DO NOTHING;
INSERT INTO role_capabilities(role_code,capability) VALUES
  ('order_merchandiser','quantity:confirm')
ON CONFLICT DO NOTHING;
CREATE TRIGGER capability_catalog_no_insert BEFORE INSERT ON capability_catalog FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER role_capabilities_no_insert BEFORE INSERT ON role_capabilities FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();

CREATE OR REPLACE FUNCTION require_whole_order_review_event(
  expected_action text,
  expected_capability text,
  order_id uuid,
  expected_actor uuid
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  audit_event_id text := nullif(current_setting('dx_rework.whole_order_review_event_id', true), '');
  audit_request_id text := nullif(current_setting('dx_rework.whole_order_review_request_id', true), '');
BEGIN
  IF audit_event_id IS NULL OR audit_request_id IS NULL
     OR audit_request_id !~ '^[A-Za-z0-9._:-]{1,128}$'
  THEN RAISE EXCEPTION 'whole-order review requires trusted audit context' USING ERRCODE='55000'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM operation_events event
    WHERE event.event_id=audit_event_id::uuid AND event.request_id=audit_request_id
      AND event.action=expected_action AND event.authorization_capability=expected_capability
      AND event.entity_type='rework_order' AND event.entity_id=order_id::text AND event.actor_id=expected_actor
  ) THEN RAISE EXCEPTION 'whole-order review audit event does not match the write' USING ERRCODE='55000'; END IF;
END;
$$;

CREATE OR REPLACE FUNCTION require_quantity_adjustment_event(
  expected_action text,
  expected_capability text,
  order_id uuid,
  expected_actor uuid
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  audit_event_id text := nullif(current_setting('dx_rework.quantity_adjustment_event_id', true), '');
  audit_request_id text := nullif(current_setting('dx_rework.quantity_adjustment_request_id', true), '');
BEGIN
  IF audit_event_id IS NULL OR audit_request_id IS NULL
     OR audit_request_id !~ '^[A-Za-z0-9._:-]{1,128}$'
  THEN RAISE EXCEPTION 'quantity adjustment requires trusted audit context' USING ERRCODE='55000'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM operation_events event
    WHERE event.event_id=audit_event_id::uuid AND event.request_id=audit_request_id
      AND event.action=expected_action AND event.authorization_capability=expected_capability
      AND event.entity_type='rework_order' AND event.entity_id=order_id::text AND event.actor_id=expected_actor
  ) THEN RAISE EXCEPTION 'quantity adjustment audit event does not match the write' USING ERRCODE='55000'; END IF;
END;
$$;

CREATE OR REPLACE FUNCTION guard_rework_work_report_resubmission() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.resubmits_work_report_id IS NULL THEN RETURN NEW; END IF;
  IF NEW.resubmits_work_report_id=NEW.work_report_id OR NOT EXISTS (
    SELECT 1 FROM rework_work_reports old_report
    JOIN rework_work_report_rejections rejection ON rejection.work_report_id=old_report.work_report_id
    WHERE old_report.work_report_id=NEW.resubmits_work_report_id
      AND old_report.rework_order_id=NEW.rework_order_id
      AND old_report.work_task_id=NEW.work_task_id
      AND old_report.configuration_item_id=NEW.configuration_item_id
  ) THEN RAISE EXCEPTION 'a report can resubmit only its rejected historical version' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER rework_work_reports_resubmission_guard_insert
  BEFORE INSERT ON rework_work_reports
  FOR EACH ROW EXECUTE FUNCTION guard_rework_work_report_resubmission();

CREATE OR REPLACE FUNCTION guard_rework_work_report_rejection_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM rework_work_reports report
    JOIN rework_work_tasks task ON task.work_task_id=report.work_task_id
    LEFT JOIN rework_work_task_members member ON member.work_task_id=report.work_task_id AND member.person_id=NEW.rejected_person_id
    WHERE report.work_report_id=NEW.work_report_id AND report.rework_order_id=NEW.rework_order_id
      AND ((task.mode='collective' AND NEW.rejected_person_id IS NULL) OR (task.mode='individual' AND member.person_id IS NOT NULL))
  ) THEN RAISE EXCEPTION 'rejection target does not match report mode' USING ERRCODE='23514'; END IF;
  PERFORM require_whole_order_review_event('rework.work_report.reject','submission:audit',NEW.rework_order_id,NEW.rejected_by);
  RETURN NEW;
END;
$$;
CREATE TRIGGER rework_work_report_rejections_guard_insert
  BEFORE INSERT ON rework_work_report_rejections
  FOR EACH ROW EXECUTE FUNCTION guard_rework_work_report_rejection_insert();
CREATE TRIGGER rework_work_report_rejections_no_update
  BEFORE UPDATE ON rework_work_report_rejections
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER rework_work_report_rejections_no_delete
  BEFORE DELETE ON rework_work_report_rejections
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER rework_work_report_rejections_no_truncate
  BEFORE TRUNCATE ON rework_work_report_rejections
  FOR EACH STATEMENT EXECUTE FUNCTION reject_operation_event_mutation();

CREATE OR REPLACE FUNCTION guard_rework_process_quantity_adjustment_write() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  expected_action text;
  expected_capability text;
BEGIN
  IF TG_OP='INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM rework_process_configuration_items item JOIN rework_process_configurations configuration ON configuration.configuration_id=item.configuration_id WHERE item.configuration_item_id=NEW.configuration_item_id AND configuration.rework_order_id=NEW.rework_order_id AND configuration.status='approved') THEN RAISE EXCEPTION 'adjustment process does not belong to approved order configuration' USING ERRCODE='23514'; END IF;
    IF NEW.previous_planned_quantity IS DISTINCT FROM COALESCE((SELECT requested_planned_quantity FROM rework_process_quantity_adjustments WHERE configuration_item_id=NEW.configuration_item_id AND status='effective' ORDER BY adjustment_version DESC LIMIT 1),(SELECT planned_quantity FROM rework_process_configuration_items WHERE configuration_item_id=NEW.configuration_item_id)) THEN RAISE EXCEPTION 'adjustment previous plan is stale' USING ERRCODE='23514'; END IF;
    IF NEW.adjustment_kind='decrease' AND NEW.requested_planned_quantity < COALESCE((SELECT sum(report.actual_quantity) FROM rework_work_reports report WHERE report.rework_order_id=NEW.rework_order_id AND report.configuration_item_id=NEW.configuration_item_id AND report.status='submitted' AND NOT EXISTS (SELECT 1 FROM rework_work_report_rejections rejection WHERE rejection.work_report_id=report.work_report_id)),0) THEN RAISE EXCEPTION 'decrease is below submitted quantity' USING ERRCODE='23514'; END IF;
    IF NEW.adjustment_kind='increase' AND (NEW.requires_ie_review IS NOT TRUE OR EXISTS (SELECT 1 FROM rework_process_quantity_adjustments active WHERE active.configuration_item_id=NEW.configuration_item_id AND active.adjustment_kind='increase' AND (active.status='pending_ie_review' OR (active.status='pending_merchandiser_confirmation' AND active.expires_at>CURRENT_TIMESTAMP)))) THEN RAISE EXCEPTION 'increase must require IE review and be the only active request' USING ERRCODE='23514'; END IF;
    IF NEW.adjustment_kind='decrease' THEN
      expected_action := 'rework.quantity.decrease'; expected_capability := 'quantity:adjust';
    ELSE
      IF NEW.status<>'pending_merchandiser_confirmation' THEN RAISE EXCEPTION 'new increase must await merchandiser confirmation' USING ERRCODE='23514'; END IF;
      expected_action := 'rework.quantity.increase.request'; expected_capability := 'quantity:adjust';
    END IF;
  ELSE
    IF NEW.adjustment_id IS DISTINCT FROM OLD.adjustment_id
       OR NEW.rework_order_id IS DISTINCT FROM OLD.rework_order_id
       OR NEW.configuration_item_id IS DISTINCT FROM OLD.configuration_item_id
       OR NEW.adjustment_version IS DISTINCT FROM OLD.adjustment_version
       OR NEW.adjustment_kind IS DISTINCT FROM OLD.adjustment_kind
       OR NEW.previous_planned_quantity IS DISTINCT FROM OLD.previous_planned_quantity
       OR NEW.requested_planned_quantity IS DISTINCT FROM OLD.requested_planned_quantity
       OR NEW.reason IS DISTINCT FROM OLD.reason
       OR NEW.requires_ie_review IS DISTINCT FROM OLD.requires_ie_review
       OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
       OR NEW.requested_by IS DISTINCT FROM OLD.requested_by
       OR NEW.requested_at IS DISTINCT FROM OLD.requested_at
    THEN RAISE EXCEPTION 'quantity adjustment history is immutable' USING ERRCODE='55000'; END IF;
    IF OLD.status='pending_merchandiser_confirmation' AND NEW.status IN ('effective','pending_ie_review','rejected') THEN
      expected_action := 'rework.quantity.increase.confirm'; expected_capability := 'quantity:confirm';
      IF NEW.confirmed_by IS NULL OR NEW.confirmed_at IS NULL OR NEW.actual_cut_quantity IS NULL
         OR NEW.actual_return_quantity IS NULL OR NEW.allowed_maximum_quantity IS NULL
      THEN RAISE EXCEPTION 'confirmation snapshot is required' USING ERRCODE='23514'; END IF;
      IF OLD.expires_at<=CURRENT_TIMESTAMP OR NEW.actual_cut_quantity<=0 OR NEW.actual_return_quantity<=0 OR NEW.allowed_maximum_quantity<=0 OR NEW.requested_planned_quantity>NEW.actual_cut_quantity OR NEW.requested_planned_quantity>NEW.actual_return_quantity OR NEW.requested_planned_quantity>NEW.allowed_maximum_quantity THEN RAISE EXCEPTION 'confirmation evidence is expired or insufficient' USING ERRCODE='23514'; END IF;
    ELSIF OLD.status='pending_ie_review' AND NEW.status IN ('effective','rejected') THEN
      expected_action := 'rework.quantity.increase.ie_review'; expected_capability := 'process:review';
      IF NEW.confirmed_by IS DISTINCT FROM OLD.confirmed_by OR NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at OR NEW.actual_cut_quantity IS DISTINCT FROM OLD.actual_cut_quantity OR NEW.actual_return_quantity IS DISTINCT FROM OLD.actual_return_quantity OR NEW.allowed_maximum_quantity IS DISTINCT FROM OLD.allowed_maximum_quantity OR NEW.confirmation_reason IS DISTINCT FROM OLD.confirmation_reason THEN RAISE EXCEPTION 'confirmation snapshot is immutable' USING ERRCODE='55000'; END IF;
      IF NEW.reviewed_by IS NULL OR NEW.reviewed_at IS NULL THEN RAISE EXCEPTION 'IE review snapshot is required' USING ERRCODE='23514'; END IF;
    ELSE RAISE EXCEPTION 'invalid quantity adjustment state transition' USING ERRCODE='23514'; END IF;
  END IF;
  PERFORM require_quantity_adjustment_event(expected_action,expected_capability,NEW.rework_order_id,CASE WHEN TG_OP='INSERT' THEN NEW.requested_by WHEN OLD.status='pending_merchandiser_confirmation' THEN NEW.confirmed_by ELSE NEW.reviewed_by END);
  RETURN NEW;
END;
$$;
CREATE TRIGGER rework_process_quantity_adjustments_guard_insert
  BEFORE INSERT ON rework_process_quantity_adjustments
  FOR EACH ROW EXECUTE FUNCTION guard_rework_process_quantity_adjustment_write();
CREATE TRIGGER rework_process_quantity_adjustments_guard_update
  BEFORE UPDATE ON rework_process_quantity_adjustments
  FOR EACH ROW EXECUTE FUNCTION guard_rework_process_quantity_adjustment_write();
CREATE TRIGGER rework_process_quantity_adjustments_no_delete
  BEFORE DELETE ON rework_process_quantity_adjustments
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER rework_process_quantity_adjustments_no_truncate
  BEFORE TRUNCATE ON rework_process_quantity_adjustments
  FOR EACH STATEMENT EXECUTE FUNCTION reject_operation_event_mutation();

CREATE OR REPLACE FUNCTION guard_rework_order_review_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM rework_process_quantity_adjustments adjustment WHERE adjustment.rework_order_id=NEW.rework_order_id AND adjustment.adjustment_kind='increase' AND (adjustment.status='pending_ie_review' OR (adjustment.status='pending_merchandiser_confirmation' AND adjustment.expires_at>CURRENT_TIMESTAMP))) THEN RAISE EXCEPTION 'active increase blocks whole-order review' USING ERRCODE='23514'; END IF;
  IF EXISTS (SELECT 1 FROM rework_process_configurations configuration JOIN rework_process_configuration_items item ON item.configuration_id=configuration.configuration_id LEFT JOIN LATERAL (SELECT adjustment.requested_planned_quantity FROM rework_process_quantity_adjustments adjustment WHERE adjustment.configuration_item_id=item.configuration_item_id AND adjustment.status='effective' ORDER BY adjustment.adjustment_version DESC LIMIT 1) plan ON true LEFT JOIN LATERAL (SELECT sum(report.actual_quantity) quantity FROM rework_work_reports report WHERE report.rework_order_id=NEW.rework_order_id AND report.configuration_item_id=item.configuration_item_id AND report.status='submitted' AND NOT EXISTS (SELECT 1 FROM rework_work_report_rejections rejection WHERE rejection.work_report_id=report.work_report_id)) completed ON true WHERE configuration.rework_order_id=NEW.rework_order_id AND configuration.status='approved' AND COALESCE(completed.quantity,0)<COALESCE(plan.requested_planned_quantity,item.planned_quantity)) THEN RAISE EXCEPTION 'incomplete order cannot be reviewed' USING ERRCODE='23514'; END IF;
  PERFORM require_whole_order_review_event('rework.whole_order.approve','submission:audit',NEW.rework_order_id,NEW.reviewed_by);
  RETURN NEW;
END;
$$;
CREATE TRIGGER rework_order_reviews_guard_insert
  BEFORE INSERT ON rework_order_reviews
  FOR EACH ROW EXECUTE FUNCTION guard_rework_order_review_insert();
CREATE TRIGGER rework_order_reviews_no_update
  BEFORE UPDATE ON rework_order_reviews
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER rework_order_reviews_no_delete
  BEFORE DELETE ON rework_order_reviews
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER rework_order_reviews_no_truncate
  BEFORE TRUNCATE ON rework_order_reviews
  FOR EACH STATEMENT EXECUTE FUNCTION reject_operation_event_mutation();

CREATE OR REPLACE FUNCTION guard_rework_order_write() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  audit_event_id text := nullif(current_setting('dx_rework.rework_event_id', true), '');
  audit_request_id text := nullif(current_setting('dx_rework.rework_request_id', true), '');
  expected_action text;
  expected_capability text;
  alternative_action text := NULL;
  alternative_capability text := NULL;
  alternative_action_two text := NULL;
  alternative_capability_two text := NULL;
  audit_actor_id uuid;
BEGIN
  IF audit_event_id IS NULL OR audit_request_id IS NULL
     OR audit_request_id !~ '^[A-Za-z0-9._:-]{1,128}$'
  THEN RAISE EXCEPTION 'rework order write requires trusted audit context' USING ERRCODE='55000'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.status<>'draft' OR NEW.version<>1 OR NEW.rework_no IS NOT NULL OR NEW.submitted_at IS NOT NULL
       OR NEW.created_by<>NEW.updated_by OR NEW.source_system<>'manual' OR NEW.external_id IS NOT NULL
       OR NEW.external_idempotency_key IS NOT NULL OR NEW.erp_node_id IS NOT NULL
    THEN RAISE EXCEPTION 'new manual rework orders must start as an unsubmitted draft' USING ERRCODE='23514'; END IF;
    expected_action := 'rework.draft.create'; expected_capability := 'rework:initiate'; audit_actor_id := NEW.created_by;
  ELSE
    IF NEW.rework_order_id IS DISTINCT FROM OLD.rework_order_id OR NEW.created_by IS DISTINCT FROM OLD.created_by
       OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.source_system IS DISTINCT FROM OLD.source_system
       OR NEW.external_id IS DISTINCT FROM OLD.external_id OR NEW.external_idempotency_key IS DISTINCT FROM OLD.external_idempotency_key
       OR NEW.erp_node_id IS DISTINCT FROM OLD.erp_node_id OR NEW.version<>OLD.version+1
    THEN RAISE EXCEPTION 'stable rework order identity and origin fields are immutable' USING ERRCODE='55000'; END IF;
    IF OLD.rework_no IS NOT NULL AND NEW.rework_no IS DISTINCT FROM OLD.rework_no THEN RAISE EXCEPTION 'allocated rework number is immutable' USING ERRCODE='55000'; END IF;
    IF OLD.submitted_at IS NOT NULL AND NEW.submitted_at IS DISTINCT FROM OLD.submitted_at THEN RAISE EXCEPTION 'first submission timestamp is immutable' USING ERRCODE='55000'; END IF;
    IF OLD.status='draft' AND NEW.status='draft' THEN expected_action := 'rework.draft.update'; expected_capability := 'rework:initiate';
    ELSIF OLD.status='draft' AND NEW.status='pending_process_configuration' THEN expected_action := 'rework.submit'; expected_capability := 'rework:initiate';
    ELSIF OLD.status='pending_process_configuration' AND NEW.status='draft' THEN expected_action := 'rework.withdraw'; expected_capability := 'rework:initiate';
    ELSIF OLD.status='pending_process_configuration' AND NEW.status='pending_ie_review' THEN expected_action := 'rework.process_configuration.submit'; expected_capability := 'process:configure';
    ELSIF OLD.status='pending_process_configuration' AND NEW.status='pending_process_configuration' THEN expected_action := 'rework.process_configuration.save'; expected_capability := 'process:configure';
    ELSIF OLD.status='pending_ie_review' AND NEW.status='pending_process_configuration' THEN expected_action := 'rework.process_configuration.review'; expected_capability := 'process:review';
    ELSIF OLD.status='pending_ie_review' AND NEW.status='pending_task_assignment' THEN expected_action := 'rework.process_configuration.review'; expected_capability := 'process:review';
    ELSIF OLD.status='pending_task_assignment' AND NEW.status='pending_ie_review' THEN expected_action := 'rework.process_configuration.submit'; expected_capability := 'process:configure';
    ELSIF OLD.status='pending_task_assignment' AND NEW.status='pending_task_assignment' THEN expected_action := 'rework.process_configuration.save'; expected_capability := 'process:configure';
    ELSIF OLD.status='pending_task_assignment' AND NEW.status='in_progress' THEN expected_action := 'rework.work_task.assign'; expected_capability := 'work:assign';
    ELSIF OLD.status='in_progress' AND NEW.status='in_progress' THEN expected_action := 'rework.quantity.decrease'; expected_capability := 'quantity:adjust';
    ELSIF OLD.status='in_progress' AND NEW.status='pending_order_review' THEN
      expected_action := 'rework.work_report.submit'; expected_capability := 'work:report';
      alternative_action := 'rework.quantity.decrease'; alternative_capability := 'quantity:adjust';
    ELSIF OLD.status='pending_order_review' AND NEW.status='pending_order_review' THEN
      expected_action := 'rework.quantity.decrease'; expected_capability := 'quantity:adjust';
      alternative_action := 'rework.quantity.increase.request'; alternative_capability := 'quantity:adjust';
      alternative_action_two := 'rework.quantity.increase.confirm'; alternative_capability_two := 'quantity:confirm';
    ELSIF OLD.status='pending_order_review' AND NEW.status='in_progress' THEN
      expected_action := 'rework.work_report.reject'; expected_capability := 'submission:audit';
      alternative_action := 'rework.quantity.increase.confirm'; alternative_capability := 'quantity:confirm';
    ELSIF OLD.status='pending_order_review' AND NEW.status='pending_quantity_adjustment_ie_review' THEN expected_action := 'rework.quantity.increase.confirm'; expected_capability := 'quantity:confirm';
    ELSIF OLD.status='pending_quantity_adjustment_ie_review' AND NEW.status='in_progress' THEN expected_action := 'rework.quantity.increase.ie_review'; expected_capability := 'process:review';
    ELSIF OLD.status='pending_quantity_adjustment_ie_review' AND NEW.status='pending_order_review' THEN expected_action := 'rework.quantity.increase.ie_review'; expected_capability := 'process:review';
    ELSIF OLD.status='pending_order_review' AND NEW.status='pending_responsibility_determination' THEN expected_action := 'rework.whole_order.approve'; expected_capability := 'submission:audit';
    ELSIF OLD.status IN ('draft','pending_process_configuration') AND NEW.status='cancelled' THEN expected_action := 'rework.cancel'; expected_capability := 'rework:initiate';
    ELSE RAISE EXCEPTION 'invalid rework order state transition: % to %', OLD.status,NEW.status USING ERRCODE='23514'; END IF;
    audit_actor_id := NEW.updated_by;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM operation_events event
    WHERE event.event_id=audit_event_id::uuid AND event.request_id=audit_request_id AND event.actor_id=audit_actor_id
      AND event.entity_type='rework_order' AND event.entity_id=NEW.rework_order_id::text
      AND ((event.action=expected_action AND (event.authorization_capability=expected_capability OR (expected_action='rework.work_report.submit' AND event.authorization_capability IN ('work:report','work:report_for_worker'))))
        OR (alternative_action IS NOT NULL AND event.action=alternative_action AND event.authorization_capability=alternative_capability)
        OR (alternative_action_two IS NOT NULL AND event.action=alternative_action_two AND event.authorization_capability=alternative_capability_two))
      AND event.after_state @> jsonb_build_object(
        'reworkOrderId',NEW.rework_order_id,'reworkNo',NEW.rework_no,'status',NEW.status,'styleNo',NEW.style_no,
        'orderNo',NEW.order_no,'merchandiserUserId',NEW.merchandiser_user_id,
        'processingFactory',CASE WHEN NEW.processing_factory_type IS NULL THEN NULL WHEN NEW.processing_factory_type='own_factory' THEN jsonb_build_object('type','own_factory') ELSE jsonb_build_object('type','supplier','supplierId',NEW.processing_factory_supplier_id,'supplierVersion',NEW.processing_factory_supplier_version) END,
        'problemPart',NEW.problem_part,'problemDescription',NEW.problem_description,'reworkQuantity',NEW.rework_quantity,'version',NEW.version
      )
      AND (NEW.status<>'cancelled' OR (event.after_state->>'cancelReason'=NEW.cancel_reason AND NEW.cancelled_by=audit_actor_id))
  ) THEN RAISE EXCEPTION 'rework order audit event does not match the write' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END;
$$;
