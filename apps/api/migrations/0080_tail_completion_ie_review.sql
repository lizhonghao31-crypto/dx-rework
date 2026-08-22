-- PR-05: split tail final-production confirmation from IE result review.
-- N07 stores the immutable production fact; N08 is the only path that can
-- publish wages and advance the order into responsibility determination.

ALTER TABLE rework_orders DROP CONSTRAINT IF EXISTS rework_orders_status_check;
ALTER TABLE rework_orders ADD CONSTRAINT rework_orders_status_check CHECK(status IN (
  'draft','pending_process_configuration','pending_ie_review','pending_task_assignment',
  'in_progress','pending_order_review','pending_quantity_adjustment_ie_review',
  'pending_completion_ie_review','pending_responsibility_determination',
  'pending_owner_signature','pending_responsibility_action','completed','cancelled','deleted'
));

CREATE TABLE rework_final_completion_confirmations (
  completion_confirmation_id uuid PRIMARY KEY,
  rework_order_id uuid NOT NULL REFERENCES rework_orders(rework_order_id),
  confirmation_version integer NOT NULL CHECK(confirmation_version>0),
  confirmed_by uuid NOT NULL REFERENCES app_users(id),
  confirmed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  operation_event_id uuid NOT NULL REFERENCES operation_events(event_id),
  request_id text NOT NULL CHECK(request_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  UNIQUE(rework_order_id,confirmation_version)
);

CREATE TABLE rework_final_completion_confirmation_items (
  completion_confirmation_id uuid NOT NULL
    REFERENCES rework_final_completion_confirmations(completion_confirmation_id),
  configuration_item_id uuid NOT NULL
    REFERENCES rework_process_configuration_items(configuration_item_id),
  worker_reported_quantity numeric(14,2) NOT NULL CHECK(worker_reported_quantity>0),
  tail_checked_quantity numeric(14,2) NOT NULL CHECK(tail_checked_quantity>0),
  original_quantity numeric(14,2) NOT NULL CHECK(original_quantity>0),
  final_confirmed_quantity numeric(14,2) NOT NULL CHECK(final_confirmed_quantity>0),
  modified_by uuid REFERENCES app_users(id),
  modified_at timestamptz,
  PRIMARY KEY(completion_confirmation_id,configuration_item_id),
  CHECK(original_quantity=worker_reported_quantity),
  CHECK(final_confirmed_quantity<=tail_checked_quantity),
  CHECK(
    (final_confirmed_quantity=original_quantity AND modified_by IS NULL AND modified_at IS NULL)
    OR
    (final_confirmed_quantity<>original_quantity AND modified_by IS NOT NULL AND modified_at IS NOT NULL)
  )
);

CREATE TABLE rework_final_completion_coefficients (
  completion_confirmation_id uuid NOT NULL
    REFERENCES rework_final_completion_confirmations(completion_confirmation_id),
  configuration_item_id uuid NOT NULL
    REFERENCES rework_process_configuration_items(configuration_item_id),
  person_id uuid NOT NULL REFERENCES business_people(person_id),
  multiplier numeric(8,3) NOT NULL CHECK(multiplier>0 AND multiplier<=10),
  reason text CHECK(reason IS NULL OR length(btrim(reason)) BETWEEN 1 AND 500),
  PRIMARY KEY(completion_confirmation_id,configuration_item_id,person_id),
  CHECK(multiplier=1 OR reason IS NOT NULL)
);

CREATE TABLE rework_completion_ie_reviews (
  completion_ie_review_id uuid PRIMARY KEY,
  completion_confirmation_id uuid NOT NULL UNIQUE
    REFERENCES rework_final_completion_confirmations(completion_confirmation_id),
  rework_order_id uuid NOT NULL REFERENCES rework_orders(rework_order_id),
  decision text NOT NULL CHECK(decision IN ('approved','rejected')),
  reason text CHECK(reason IS NULL OR length(btrim(reason)) BETWEEN 1 AND 500),
  reviewed_by uuid NOT NULL REFERENCES app_users(id),
  reviewed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  operation_event_id uuid NOT NULL REFERENCES operation_events(event_id),
  request_id text NOT NULL CHECK(request_id ~ '^[A-Za-z0-9._:-]{1,128}$')
);
CREATE INDEX rework_completion_ie_reviews_order_idx
  ON rework_completion_ie_reviews(rework_order_id,reviewed_at DESC);

CREATE OR REPLACE FUNCTION guard_final_completion_confirmation()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  source_event operation_events%ROWTYPE;
  expected_version integer;
BEGIN
  SELECT COALESCE(max(existing.confirmation_version),0)+1
  INTO expected_version
  FROM rework_final_completion_confirmations existing
  WHERE existing.rework_order_id=NEW.rework_order_id;
  SELECT * INTO source_event
  FROM operation_events event
  WHERE event.event_id=nullif(current_setting('dx_rework.rework_event_id',true),'')::uuid
    AND event.request_id=nullif(current_setting('dx_rework.rework_request_id',true),'')
    AND event.event_id=NEW.operation_event_id
    AND event.request_id=NEW.request_id
    AND event.actor_id=NEW.confirmed_by
    AND event.action='rework.completion.confirm'
    AND event.authorization_capability='submission:audit'
    AND event.entity_type='rework_order'
    AND event.entity_id=NEW.rework_order_id::text;
  IF source_event.event_id IS NULL
     OR NEW.confirmation_version<>expected_version
     OR NOT EXISTS(
       SELECT 1 FROM rework_orders target
       WHERE target.rework_order_id=NEW.rework_order_id AND target.status='pending_order_review'
     ) THEN
    RAISE EXCEPTION 'final completion confirmation requires the audited N07 state'
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER rework_final_completion_confirmations_guard
  BEFORE INSERT ON rework_final_completion_confirmations
  FOR EACH ROW EXECUTE FUNCTION guard_final_completion_confirmation();
CREATE TRIGGER rework_final_completion_confirmations_no_update
  BEFORE UPDATE ON rework_final_completion_confirmations
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER rework_final_completion_confirmations_no_delete
  BEFORE DELETE ON rework_final_completion_confirmations
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();

CREATE OR REPLACE FUNCTION guard_final_completion_item()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_order_id uuid;
  target_actor uuid;
BEGIN
  SELECT confirmation.rework_order_id,confirmation.confirmed_by
  INTO target_order_id,target_actor
  FROM rework_final_completion_confirmations confirmation
  WHERE confirmation.completion_confirmation_id=NEW.completion_confirmation_id;
  IF target_order_id IS NULL
     OR NOT EXISTS(
       SELECT 1 FROM operation_events event
       WHERE event.event_id=nullif(current_setting('dx_rework.rework_event_id',true),'')::uuid
         AND event.request_id=nullif(current_setting('dx_rework.rework_request_id',true),'')
         AND event.actor_id=target_actor
         AND event.action='rework.completion.confirm'
         AND event.authorization_capability='submission:audit'
         AND event.entity_type='rework_order'
         AND event.entity_id=target_order_id::text
     )
     OR NOT EXISTS(
       SELECT 1
       FROM rework_process_configurations configuration
       JOIN rework_process_configuration_items item USING(configuration_id)
       WHERE configuration.rework_order_id=target_order_id
         AND configuration.status='approved'
         AND item.execution_kind='worker'
         AND item.configuration_item_id=NEW.configuration_item_id
     ) THEN
    RAISE EXCEPTION 'final completion item requires an audited worker process'
      USING ERRCODE='55000';
  END IF;
  IF NEW.modified_by IS NOT NULL AND NEW.modified_by<>target_actor THEN
    RAISE EXCEPTION 'final quantity modifier must be the confirming supervisor'
      USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER rework_final_completion_items_guard
  BEFORE INSERT ON rework_final_completion_confirmation_items
  FOR EACH ROW EXECUTE FUNCTION guard_final_completion_item();
CREATE TRIGGER rework_final_completion_items_no_update
  BEFORE UPDATE ON rework_final_completion_confirmation_items
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER rework_final_completion_items_no_delete
  BEFORE DELETE ON rework_final_completion_confirmation_items
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();

CREATE OR REPLACE FUNCTION guard_final_completion_coefficient()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_order_id uuid;
  target_actor uuid;
BEGIN
  SELECT confirmation.rework_order_id,confirmation.confirmed_by
  INTO target_order_id,target_actor
  FROM rework_final_completion_confirmations confirmation
  WHERE confirmation.completion_confirmation_id=NEW.completion_confirmation_id;
  IF target_order_id IS NULL OR NOT EXISTS(
    SELECT 1 FROM operation_events event
    WHERE event.event_id=nullif(current_setting('dx_rework.rework_event_id',true),'')::uuid
      AND event.request_id=nullif(current_setting('dx_rework.rework_request_id',true),'')
      AND event.actor_id=target_actor
      AND event.action='rework.completion.confirm'
      AND event.authorization_capability='submission:audit'
      AND event.entity_type='rework_order'
      AND event.entity_id=target_order_id::text
  ) THEN
    RAISE EXCEPTION 'final completion coefficient requires audited N07 confirmation'
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER rework_final_completion_coefficients_guard
  BEFORE INSERT ON rework_final_completion_coefficients
  FOR EACH ROW EXECUTE FUNCTION guard_final_completion_coefficient();
CREATE TRIGGER rework_final_completion_coefficients_no_update
  BEFORE UPDATE ON rework_final_completion_coefficients
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER rework_final_completion_coefficients_no_delete
  BEFORE DELETE ON rework_final_completion_coefficients
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();

CREATE OR REPLACE FUNCTION guard_completion_ie_review()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  confirmation rework_final_completion_confirmations%ROWTYPE;
  expected_action text;
BEGIN
  SELECT * INTO confirmation
  FROM rework_final_completion_confirmations
  WHERE completion_confirmation_id=NEW.completion_confirmation_id;
  expected_action:=CASE NEW.decision
    WHEN 'approved' THEN 'rework.completion_ie_review.approve'
    ELSE 'rework.completion_ie_review.reject'
  END;
  IF confirmation.completion_confirmation_id IS NULL
     OR confirmation.rework_order_id<>NEW.rework_order_id
     OR NOT EXISTS(
       SELECT 1 FROM rework_orders target
       WHERE target.rework_order_id=NEW.rework_order_id
         AND target.status='pending_completion_ie_review'
     )
     OR NOT EXISTS(
       SELECT 1 FROM operation_events event
       WHERE event.event_id=nullif(current_setting('dx_rework.rework_event_id',true),'')::uuid
         AND event.request_id=nullif(current_setting('dx_rework.rework_request_id',true),'')
         AND event.event_id=NEW.operation_event_id
         AND event.request_id=NEW.request_id
         AND event.actor_id=NEW.reviewed_by
         AND event.action=expected_action
         AND event.authorization_capability='process:review'
         AND event.entity_type='rework_order'
         AND event.entity_id=NEW.rework_order_id::text
     ) THEN
    RAISE EXCEPTION 'IE completion review requires the audited N08 state'
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER rework_completion_ie_reviews_guard
  BEFORE INSERT ON rework_completion_ie_reviews
  FOR EACH ROW EXECUTE FUNCTION guard_completion_ie_review();
CREATE TRIGGER rework_completion_ie_reviews_no_update
  BEFORE UPDATE ON rework_completion_ie_reviews
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER rework_completion_ie_reviews_no_delete
  BEFORE DELETE ON rework_completion_ie_reviews
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();

-- Final wage values are allowed to change only when N08 approves the immutable
-- N07 final quantities. Raw work-report quantities remain immutable.
CREATE OR REPLACE FUNCTION guard_rework_work_report_final_amount()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW)-'group_amount') IS DISTINCT FROM (to_jsonb(OLD)-'group_amount')
     OR NEW.group_amount<=0
     OR NOT EXISTS(
       SELECT 1 FROM operation_events event
       WHERE event.event_id=nullif(current_setting('dx_rework.rework_event_id',true),'')::uuid
         AND event.request_id=nullif(current_setting('dx_rework.rework_request_id',true),'')
         AND event.action='rework.completion_ie_review.approve'
         AND event.authorization_capability='process:review'
         AND event.entity_type='rework_order'
         AND event.entity_id=OLD.rework_order_id::text
     ) THEN
    RAISE EXCEPTION 'work report amount can only follow an IE-approved final quantity'
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION guard_rework_work_report_share_final_amount()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW)-'amount') IS DISTINCT FROM (to_jsonb(OLD)-'amount')
     OR NEW.amount<=0
     OR NOT EXISTS(
       SELECT 1
       FROM rework_work_reports report
       JOIN operation_events event ON event.entity_id=report.rework_order_id::text
       WHERE report.work_report_id=OLD.work_report_id
         AND event.event_id=nullif(current_setting('dx_rework.rework_event_id',true),'')::uuid
         AND event.request_id=nullif(current_setting('dx_rework.rework_request_id',true),'')
         AND event.action='rework.completion_ie_review.approve'
         AND event.authorization_capability='process:review'
     ) THEN
    RAISE EXCEPTION 'work report share can only follow an IE-approved final quantity'
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;

-- rework_order_reviews remains the single, final IE-approved wage source. It is
-- intentionally not created at N07; a rejection therefore never materializes wages.
CREATE OR REPLACE FUNCTION guard_rework_order_review_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  confirmation_id uuid;
BEGIN
  SELECT review.completion_confirmation_id
  INTO confirmation_id
  FROM rework_completion_ie_reviews review
  JOIN rework_final_completion_confirmations confirmation
    ON confirmation.completion_confirmation_id=review.completion_confirmation_id
  WHERE review.rework_order_id=NEW.rework_order_id
    AND review.decision='approved'
    AND review.reviewed_by=NEW.reviewed_by
    AND review.operation_event_id=nullif(current_setting('dx_rework.rework_event_id',true),'')::uuid
    AND review.request_id=nullif(current_setting('dx_rework.rework_request_id',true),'')
  ORDER BY confirmation.confirmation_version DESC
  LIMIT 1;
  IF confirmation_id IS NULL
     OR NOT EXISTS(
       SELECT 1 FROM rework_orders target
       WHERE target.rework_order_id=NEW.rework_order_id
         AND target.status='pending_completion_ie_review'
     )
     OR EXISTS(
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
     )
     OR EXISTS(
       SELECT 1 FROM rework_work_reports report
       WHERE report.rework_order_id=NEW.rework_order_id AND report.status='submitted'
         AND NOT EXISTS(
           SELECT 1 FROM rework_work_report_rejections rejection
           WHERE rejection.work_report_id=report.work_report_id
         )
         AND report.group_amount<=0
     )
     OR NOT EXISTS(
       SELECT 1 FROM operation_events event
       WHERE event.event_id=nullif(current_setting('dx_rework.rework_event_id',true),'')::uuid
         AND event.request_id=nullif(current_setting('dx_rework.rework_request_id',true),'')
         AND event.actor_id=NEW.reviewed_by
         AND event.action='rework.completion_ie_review.approve'
         AND event.authorization_capability='process:review'
         AND event.entity_type='rework_order'
         AND event.entity_id=NEW.rework_order_id::text
     ) THEN
    RAISE EXCEPTION 'order review requires an approved N08 completion review'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

-- Allow the N08 approval event to be the source event consumed by the existing
-- wage materialization trigger.
CREATE OR REPLACE FUNCTION require_wage_materialization_event(
  target_review_id uuid
) RETURNS operation_events LANGUAGE plpgsql AS $$
DECLARE
  event_record operation_events%ROWTYPE;
  target_order_id uuid;
BEGIN
  SELECT rework_order_id INTO target_order_id
  FROM rework_order_reviews WHERE order_review_id=target_review_id;
  SELECT * INTO event_record
  FROM operation_events event
  WHERE event.event_id=nullif(current_setting('dx_rework.whole_order_review_event_id',true),'')::uuid
    AND event.request_id=nullif(current_setting('dx_rework.whole_order_review_request_id',true),'');
  IF target_order_id IS NULL OR event_record.event_id IS NULL
     OR event_record.entity_type<>'rework_order'
     OR event_record.entity_id<>target_order_id::text
     OR NOT (
       (event_record.action='rework.whole_order.approve' AND event_record.authorization_capability='submission:audit')
       OR (event_record.action='rework.tail_pricing.ie_approve' AND event_record.authorization_capability='process:review')
       OR (event_record.action='rework.completion_ie_review.approve' AND event_record.authorization_capability='process:review')
     ) THEN
    RAISE EXCEPTION 'wage materialization requires an approved wage-source event'
      USING ERRCODE='55000';
  END IF;
  RETURN event_record;
END;
$$;

CREATE OR REPLACE FUNCTION guard_wage_period_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE event_record operation_events%ROWTYPE;
BEGIN
  IF nullif(current_setting('dx_rework.wage_system_action',true),'') IS DISTINCT FROM 'materialize'
     OR NEW.status<>'pending_tail_review' OR NEW.period_version<>1
     OR NEW.source_item_count<>0 OR NEW.person_count<>0 OR NEW.original_total<>0
     OR NEW.adjustment_total<>0 OR NEW.final_total<>0 OR NEW.locked_by IS NOT NULL
     OR NEW.locked_at IS NOT NULL THEN
    RAISE EXCEPTION 'wage period must be created by materialization' USING ERRCODE='55000';
  END IF;
  SELECT * INTO event_record FROM operation_events
  WHERE event_id=NEW.created_operation_event_id AND request_id=NEW.created_request_id
    AND (
      (action='rework.whole_order.approve' AND authorization_capability='submission:audit')
      OR (action='rework.tail_pricing.ie_approve' AND authorization_capability='process:review')
      OR (action='rework.completion_ie_review.approve' AND authorization_capability='process:review')
    );
  IF event_record.event_id IS NULL THEN
    RAISE EXCEPTION 'wage period creation lacks reviewed source event' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION guard_wage_item_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_record record;
BEGIN
  IF nullif(current_setting('dx_rework.wage_system_action',true),'') IS DISTINCT FROM 'materialize'
     OR NOT EXISTS(
       SELECT 1 FROM operation_events event
       WHERE event.event_id=NEW.operation_event_id AND event.request_id=NEW.operation_request_id
         AND (
           (event.action='rework.whole_order.approve' AND event.authorization_capability='submission:audit')
           OR (event.action='rework.tail_pricing.ie_approve' AND event.authorization_capability='process:review')
           OR (event.action='rework.completion_ie_review.approve' AND event.authorization_capability='process:review')
         )
     ) THEN
    RAISE EXCEPTION 'wage item must be materialized from reviewed work' USING ERRCODE='55000';
  END IF;
  SELECT report.rework_order_id,report.configuration_item_id,report.work_task_id,
         report.group_amount,share.amount,member.display_name_snapshot,member.person_type_snapshot,
         task.assignment_mode,item.process_name,item.pricing_unit,item.unit_price,
         target_order.rework_no,target_order.style_no
  INTO source_record
  FROM rework_work_reports report
  JOIN rework_work_report_member_shares share
    ON share.work_report_id=report.work_report_id AND share.person_id=NEW.person_id
  JOIN rework_work_tasks task ON task.work_task_id=report.work_task_id
  JOIN rework_work_task_members member
    ON member.work_task_id=task.work_task_id AND member.person_id=NEW.person_id
  JOIN rework_process_configuration_items item
    ON item.configuration_item_id=report.configuration_item_id
  JOIN rework_orders target_order ON target_order.rework_order_id=report.rework_order_id
  WHERE report.work_report_id=NEW.work_report_id AND report.status='submitted'
    AND NOT EXISTS(
      SELECT 1 FROM rework_work_report_rejections rejection
      WHERE rejection.work_report_id=report.work_report_id
    );
  IF source_record.rework_order_id IS NULL
     OR NEW.rework_order_id<>source_record.rework_order_id
     OR NEW.configuration_item_id<>source_record.configuration_item_id
     OR NEW.work_task_id<>source_record.work_task_id
     OR NEW.group_amount<>source_record.group_amount
     OR NEW.exact_person_share<>source_record.amount
     OR NEW.person_name_snapshot<>source_record.display_name_snapshot
     OR NEW.person_type_snapshot<>source_record.person_type_snapshot
     OR NEW.assignment_mode<>source_record.assignment_mode
     OR NEW.process_name_snapshot<>source_record.process_name
     OR NEW.pricing_unit_snapshot<>source_record.pricing_unit
     OR NEW.unit_price_snapshot<>source_record.unit_price
     OR NEW.rework_no_snapshot<>source_record.rework_no
     OR NEW.style_no_snapshot<>source_record.style_no THEN
    RAISE EXCEPTION 'wage item snapshot does not match reviewed source' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

-- Preserve every current order transition and replace only the old direct
-- N07 -> responsibility jump with N07 -> N08 -> responsibility/return.
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
      ELSIF OLD.status='pending_order_review' AND NEW.status='pending_completion_ie_review' THEN expected_action:='rework.completion.confirm'; expected_capability:='submission:audit';
      ELSIF OLD.status='pending_completion_ie_review' AND NEW.status='pending_responsibility_determination' THEN expected_action:='rework.completion_ie_review.approve'; expected_capability:='process:review';
      ELSIF OLD.status='pending_completion_ie_review' AND NEW.status='pending_order_review' THEN expected_action:='rework.completion_ie_review.reject'; expected_capability:='process:review';
      ELSIF OLD.status='pending_responsibility_determination' AND NEW.status='pending_responsibility_determination' THEN expected_action:='rework.responsibility.draft'; expected_capability:='responsibility:determine'; alternative_action:='rework.responsibility.transfer'; alternative_capability:='responsibility:determine'; alternative_action_two:='rework.responsibility.takeover'; alternative_capability_two:='responsibility:takeover'; alternative_action_three:='rework.responsibility.high_multiplier.confirm'; alternative_capability_three:='responsibility:confirm_high_multiplier';
      ELSIF OLD.status='pending_responsibility_determination' AND NEW.status='pending_owner_signature' THEN expected_action:='rework.responsibility.submit_owner_signature'; expected_capability:='responsibility:determine'; ELSIF OLD.status='pending_responsibility_determination' AND NEW.status='pending_responsibility_action' THEN expected_action:='rework.responsibility.finalize'; expected_capability:='responsibility:determine'; ELSIF OLD.status='pending_owner_signature' AND NEW.status='pending_responsibility_determination' THEN expected_action:='rework.responsibility.owner_reject'; expected_capability:='responsibility:owner_sign'; ELSIF OLD.status='pending_owner_signature' AND NEW.status='completed' THEN expected_action:='rework.responsibility.owner_approve'; expected_capability:='responsibility:owner_sign'; ELSIF OLD.status='pending_responsibility_action' AND NEW.status='pending_responsibility_determination' THEN expected_action:='rework.own_factory_approval.reject'; expected_capability:='own_factory:approve'; alternative_action:='rework.external_responsibility.revision.approve'; alternative_capability:='external_responsibility:approve_revision'; ELSIF OLD.status='pending_responsibility_action' AND NEW.status='completed' THEN expected_action:='rework.responsibility.complete'; expected_capability:='external_responsibility:payables_confirm'; alternative_action:='rework.responsibility.complete'; alternative_capability:='own_factory:approve'; alternative_action_two:='rework.responsibility.complete'; alternative_capability_two:='responsibility:determine'; ELSIF OLD.status='completed' AND NEW.status='pending_responsibility_determination' THEN expected_action:='rework.external_responsibility.revision.approve'; expected_capability:='external_responsibility:approve_revision'; ELSIF OLD.status IN ('draft','pending_process_configuration') AND NEW.status='cancelled' THEN expected_action:='rework.cancel'; expected_capability:='rework:initiate'; ELSE RAISE EXCEPTION 'invalid rework order state transition: % to %',OLD.status,NEW.status USING ERRCODE='23514'; END IF;
    END IF; audit_actor_id:=NEW.updated_by;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM operation_events event WHERE event.event_id=audit_event_id::uuid AND event.request_id=audit_request_id AND event.actor_id=audit_actor_id AND event.entity_type='rework_order' AND event.entity_id=NEW.rework_order_id::text AND ((event.action=expected_action AND (event.authorization_capability=expected_capability OR (expected_action='rework.work_report.submit' AND event.authorization_capability IN ('work:report','work:report_for_worker','tail_inspection:report')))) OR (alternative_action IS NOT NULL AND event.action=alternative_action AND event.authorization_capability=alternative_capability) OR (alternative_action_two IS NOT NULL AND event.action=alternative_action_two AND event.authorization_capability=alternative_capability_two) OR (alternative_action_three IS NOT NULL AND event.action=alternative_action_three AND event.authorization_capability=alternative_capability_three)) AND event.after_state @> jsonb_build_object('reworkOrderId',NEW.rework_order_id,'reworkNo',NEW.rework_no,'status',NEW.status,'styleNo',NEW.style_no,'orderNo',NEW.order_no,'merchandiserUserId',NEW.merchandiser_user_id,'processingFactory',CASE WHEN NEW.processing_factory_type IS NULL THEN NULL WHEN NEW.processing_factory_type='own_factory' THEN jsonb_build_object('type','own_factory') ELSE jsonb_build_object('type','supplier','supplierId',NEW.processing_factory_supplier_id,'supplierVersion',NEW.processing_factory_supplier_version) END,'problemPart',NEW.problem_part,'problemDescription',NEW.problem_description,'reworkQuantity',NEW.rework_quantity,'version',NEW.version) AND (NEW.status<>'cancelled' OR (event.after_state->>'cancelReason'=NEW.cancel_reason AND NEW.cancelled_by=audit_actor_id)) AND (NEW.status<>'deleted' OR (event.after_state->>'deletedBy'=NEW.deleted_by::text AND NEW.deleted_by=audit_actor_id))) THEN RAISE EXCEPTION 'rework order audit event does not match the write' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
