-- 1.0 prelaunch PR-02: append-only supervisor corrections and one effective
-- quantity source for N05, N06 and wage materialization.

CREATE TABLE rework_work_report_quantity_revisions (
  quantity_revision_id uuid PRIMARY KEY,
  work_report_id uuid NOT NULL REFERENCES rework_work_reports(work_report_id),
  rework_order_id uuid NOT NULL REFERENCES rework_orders(rework_order_id),
  configuration_item_id uuid NOT NULL REFERENCES rework_process_configuration_items(configuration_item_id),
  person_id uuid NOT NULL REFERENCES business_people(person_id),
  revision_version integer NOT NULL CHECK(revision_version>0),
  original_quantity numeric(18,2) NOT NULL CHECK(original_quantity>0),
  effective_quantity numeric(18,2) NOT NULL CHECK(effective_quantity>0 AND effective_quantity=trunc(effective_quantity)),
  corrected_by uuid NOT NULL REFERENCES app_users(id),
  corrected_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  operation_event_id uuid NOT NULL REFERENCES operation_events(event_id),
  request_id text NOT NULL CHECK(request_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  UNIQUE(work_report_id,revision_version)
);

CREATE INDEX rework_work_report_quantity_revisions_latest_idx
  ON rework_work_report_quantity_revisions(work_report_id,revision_version DESC);
CREATE INDEX rework_work_report_quantity_revisions_order_process_idx
  ON rework_work_report_quantity_revisions(rework_order_id,configuration_item_id,work_report_id);

CREATE OR REPLACE FUNCTION rework_work_report_effective_quantity(target_work_report_id uuid)
RETURNS numeric
LANGUAGE sql
STABLE
STRICT
AS $$
  SELECT COALESCE(
    (
      SELECT revision.effective_quantity
      FROM rework_work_report_quantity_revisions revision
      WHERE revision.work_report_id=target_work_report_id
      ORDER BY revision.revision_version DESC
      LIMIT 1
    ),
    (
      SELECT report.actual_quantity
      FROM rework_work_reports report
      WHERE report.work_report_id=target_work_report_id
    )
  )
$$;

CREATE OR REPLACE FUNCTION guard_rework_work_report_quantity_revision()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  member_count integer;
  report_record record;
BEGIN
  SELECT report.rework_order_id,report.configuration_item_id,report.actual_quantity,
         report.status,target.status AS order_status,task.assignment_mode,
         count(member.person_id)::int AS member_count,
         (array_agg(member.person_id ORDER BY member.person_id))[1] AS person_id
  INTO report_record
  FROM rework_work_reports report
  JOIN rework_orders target ON target.rework_order_id=report.rework_order_id
  JOIN rework_work_tasks task ON task.work_task_id=report.work_task_id
  JOIN rework_work_task_members member ON member.work_task_id=task.work_task_id
  WHERE report.work_report_id=NEW.work_report_id
  GROUP BY report.rework_order_id,report.configuration_item_id,report.actual_quantity,
           report.status,target.status,task.assignment_mode;

  IF report_record.rework_order_id IS NULL
     OR report_record.status<>'submitted'
     OR report_record.order_status<>'pending_order_review'
     OR EXISTS(
       SELECT 1 FROM rework_work_report_rejections rejection
       WHERE rejection.work_report_id=NEW.work_report_id
     )
  THEN
    RAISE EXCEPTION 'quantity correction requires a valid N05 work report'
      USING ERRCODE='23514';
  END IF;

  member_count := report_record.member_count;
  IF report_record.assignment_mode<>'individual'
     OR member_count<>1 OR NEW.person_id IS DISTINCT FROM report_record.person_id THEN
    RAISE EXCEPTION 'quantity correction requires one individually reported person'
      USING ERRCODE='23514';
  END IF;

  IF NEW.rework_order_id IS DISTINCT FROM report_record.rework_order_id
     OR NEW.configuration_item_id IS DISTINCT FROM report_record.configuration_item_id
     OR NEW.original_quantity IS DISTINCT FROM report_record.actual_quantity
     OR NEW.revision_version<>COALESCE((
       SELECT max(existing.revision_version)+1
       FROM rework_work_report_quantity_revisions existing
       WHERE existing.work_report_id=NEW.work_report_id
     ),1)
  THEN
    RAISE EXCEPTION 'quantity correction identity, original fact or version is invalid'
      USING ERRCODE='23514';
  END IF;

  IF NOT EXISTS(
    SELECT 1 FROM operation_events event
    WHERE event.event_id=NEW.operation_event_id
      AND event.event_id=nullif(current_setting('dx_rework.quantity_correction_event_id',true),'')::uuid
      AND event.request_id=NEW.request_id
      AND event.request_id=nullif(current_setting('dx_rework.quantity_correction_request_id',true),'')
      AND event.actor_id=NEW.corrected_by
      AND event.authorization_capability='submission:audit'
      AND event.action='rework.work_report.quantity_correct'
      AND event.entity_type='work_report'
      AND event.entity_id=NEW.work_report_id::text
      AND event.after_state @> jsonb_build_object(
        'workReportId',NEW.work_report_id,
        'reworkOrderId',NEW.rework_order_id,
        'configurationItemId',NEW.configuration_item_id,
        'personId',NEW.person_id,
        'originalQuantity',NEW.original_quantity,
        'effectiveQuantity',NEW.effective_quantity,
        'correctionVersion',NEW.revision_version
      )
  ) THEN
    RAISE EXCEPTION 'quantity correction requires matching trusted audit event'
      USING ERRCODE='55000';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER rework_work_report_quantity_revisions_guard_insert
  BEFORE INSERT ON rework_work_report_quantity_revisions
  FOR EACH ROW EXECUTE FUNCTION guard_rework_work_report_quantity_revision();
CREATE TRIGGER rework_work_report_quantity_revisions_no_update
  BEFORE UPDATE ON rework_work_report_quantity_revisions
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER rework_work_report_quantity_revisions_no_delete
  BEFORE DELETE ON rework_work_report_quantity_revisions
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER rework_work_report_quantity_revisions_no_truncate
  BEFORE TRUNCATE ON rework_work_report_quantity_revisions
  FOR EACH STATEMENT EXECUTE FUNCTION reject_operation_event_mutation();

-- N05 stores the system-derived quantity only when every worker process exactly
-- reconciles to the effective unified tail total.
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

  SELECT COALESCE(sum(rework_work_report_effective_quantity(report.work_report_id)),0)
  INTO worker_quantity
  FROM rework_work_reports report
  JOIN rework_process_configuration_items item ON item.configuration_item_id=report.configuration_item_id
  JOIN rework_process_configurations configuration ON configuration.configuration_id=item.configuration_id
  WHERE report.rework_order_id=target_order_id
    AND report.configuration_item_id=NEW.configuration_item_id
    AND item.execution_kind='worker' AND configuration.status='approved'
    AND report.status='submitted'
    AND NOT EXISTS(SELECT 1 FROM rework_work_report_rejections rejection WHERE rejection.work_report_id=report.work_report_id);

  SELECT COALESCE(sum(rework_work_report_effective_quantity(report.work_report_id)),0)
  INTO tail_quantity
  FROM rework_work_reports report
  JOIN rework_process_configuration_items item ON item.configuration_item_id=report.configuration_item_id
  WHERE report.rework_order_id=target_order_id
    AND item.execution_kind='tail_inspection'
    AND report.status='submitted'
    AND NOT EXISTS(SELECT 1 FROM rework_work_report_rejections rejection WHERE rejection.work_report_id=report.work_report_id);

  IF worker_quantity<=0 OR worker_quantity<>tail_quantity
     OR NEW.worker_reported_quantity<>worker_quantity
     OR NEW.tail_reported_quantity<>tail_quantity
     OR NEW.final_confirmed_quantity<>worker_quantity
  THEN RAISE EXCEPTION 'final quantity must equal reconciled effective worker and tail facts' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END;
$$;

-- Replace only the N06 insert guard so reopened historical rules and all other
-- state guards remain unchanged while unified orders read effective quantities.
CREATE OR REPLACE FUNCTION guard_rework_order_review_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  unified_execution boolean;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM rework_orders target WHERE target.rework_order_id=NEW.rework_order_id AND target.status='pending_final_quantity_ie_review')
  THEN RAISE EXCEPTION 'order is not pending IE final-quantity review' USING ERRCODE='23514'; END IF;

  SELECT configuration.unified_execution_required INTO unified_execution
  FROM rework_process_configurations configuration
  WHERE configuration.rework_order_id=NEW.rework_order_id AND configuration.status='approved' LIMIT 1;

  IF unified_execution IS NULL OR EXISTS(
    SELECT 1 FROM rework_process_configurations configuration
    JOIN rework_process_configuration_items item USING(configuration_id)
    WHERE configuration.rework_order_id=NEW.rework_order_id AND configuration.status='approved' AND item.unit_price IS NULL
  ) THEN RAISE EXCEPTION 'every IE-approved process requires a price' USING ERRCODE='23514'; END IF;

  IF unified_execution AND (
    SELECT count(*) FROM rework_process_configurations configuration
    JOIN rework_process_configuration_items item USING(configuration_id)
    WHERE configuration.rework_order_id=NEW.rework_order_id AND configuration.status='approved' AND item.execution_kind='tail_inspection'
  )<>1 THEN RAISE EXCEPTION 'unified execution requires exactly one tail-inspection process' USING ERRCODE='23514'; END IF;

  IF NOT EXISTS(
    SELECT 1 FROM rework_tail_completion_confirmations confirmation
    JOIN rework_tail_completion_reviews review ON review.confirmation_id=confirmation.confirmation_id AND review.decision='approved'
    WHERE confirmation.rework_order_id=NEW.rework_order_id AND confirmation.workflow_stage='pending_ie_review'
      AND review.reviewed_by=NEW.reviewed_by
      AND review.operation_event_id=nullif(current_setting('dx_rework.rework_event_id',true),'')::uuid
      AND review.request_id=nullif(current_setting('dx_rework.rework_request_id',true),'')
  ) THEN RAISE EXCEPTION 'approved IE final-quantity review is required' USING ERRCODE='23514'; END IF;

  IF EXISTS(
    SELECT 1 FROM rework_work_tasks task
    WHERE task.rework_order_id=NEW.rework_order_id AND task.status='active'
      AND NOT EXISTS(SELECT 1 FROM rework_work_reports report WHERE report.work_task_id=task.work_task_id AND report.status='submitted'
        AND NOT EXISTS(SELECT 1 FROM rework_work_report_rejections rejection WHERE rejection.work_report_id=report.work_report_id))
  ) THEN RAISE EXCEPTION 'every active execution task requires a valid report' USING ERRCODE='23514'; END IF;

  IF NOT unified_execution AND EXISTS(
    SELECT 1 FROM rework_tail_inspection_assignments assignment
    WHERE assignment.rework_order_id=NEW.rework_order_id AND assignment.revoked_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM rework_tail_inspection_reports report
        WHERE report.tail_inspection_assignment_id=assignment.tail_inspection_assignment_id AND report.status='submitted')
  ) THEN RAISE EXCEPTION 'every active legacy tail inspector requires a submitted count' USING ERRCODE='23514'; END IF;

  IF unified_execution AND EXISTS(
    WITH tail_total AS (
      SELECT COALESCE(sum(rework_work_report_effective_quantity(report.work_report_id)),0) AS quantity
      FROM rework_work_reports report
      JOIN rework_process_configuration_items item ON item.configuration_item_id=report.configuration_item_id
      WHERE report.rework_order_id=NEW.rework_order_id AND item.execution_kind='tail_inspection' AND report.status='submitted'
        AND NOT EXISTS(SELECT 1 FROM rework_work_report_rejections rejection WHERE rejection.work_report_id=report.work_report_id)
    )
    SELECT 1 FROM rework_process_configurations configuration
    JOIN rework_process_configuration_items item ON item.configuration_id=configuration.configuration_id
    CROSS JOIN tail_total
    LEFT JOIN LATERAL (
      SELECT COALESCE(sum(rework_work_report_effective_quantity(report.work_report_id)),0) AS quantity
      FROM rework_work_reports report
      WHERE report.rework_order_id=NEW.rework_order_id AND report.configuration_item_id=item.configuration_item_id AND report.status='submitted'
        AND NOT EXISTS(SELECT 1 FROM rework_work_report_rejections rejection WHERE rejection.work_report_id=report.work_report_id)
    ) worker ON true
    WHERE configuration.rework_order_id=NEW.rework_order_id AND configuration.status='approved' AND item.execution_kind='worker'
      AND worker.quantity<>tail_total.quantity
  ) THEN RAISE EXCEPTION 'worker count must equal unified tail-inspection count' USING ERRCODE='23514'; END IF;

  IF NOT unified_execution AND EXISTS(
    SELECT 1 FROM rework_process_configurations configuration
    JOIN rework_process_configuration_items item ON item.configuration_id=configuration.configuration_id
    LEFT JOIN LATERAL (
      SELECT COALESCE(sum(report.actual_quantity),0) AS quantity FROM rework_work_reports report
      WHERE report.rework_order_id=NEW.rework_order_id AND report.configuration_item_id=item.configuration_item_id AND report.status='submitted'
        AND NOT EXISTS(SELECT 1 FROM rework_work_report_rejections rejection WHERE rejection.work_report_id=report.work_report_id)
    ) worker ON true
    LEFT JOIN LATERAL (
      SELECT COALESCE(sum(report_item.inspected_quantity),0) AS quantity
      FROM rework_tail_inspection_report_items report_item
      JOIN rework_tail_inspection_reports report ON report.tail_inspection_report_id=report_item.tail_inspection_report_id AND report.status='submitted'
      JOIN rework_tail_inspection_assignments assignment ON assignment.tail_inspection_assignment_id=report.tail_inspection_assignment_id AND assignment.revoked_at IS NULL
      WHERE report.rework_order_id=NEW.rework_order_id AND report_item.configuration_item_id=item.configuration_item_id
    ) tail_checked ON true
    WHERE configuration.rework_order_id=NEW.rework_order_id AND configuration.status='approved' AND worker.quantity>tail_checked.quantity
  ) THEN RAISE EXCEPTION 'worker count cannot exceed legacy tail inspection count' USING ERRCODE='23514'; END IF;

  IF EXISTS(
    SELECT 1 FROM rework_work_reports report
    WHERE report.rework_order_id=NEW.rework_order_id AND report.status='submitted'
      AND NOT EXISTS(SELECT 1 FROM rework_work_report_rejections rejection WHERE rejection.work_report_id=report.work_report_id)
      AND report.group_amount<=0
  ) THEN RAISE EXCEPTION 'every valid report requires generated wages' USING ERRCODE='23514'; END IF;

  PERFORM require_whole_order_review_event('rework.final_quantity.ie_review','process:review',NEW.rework_order_id,NEW.reviewed_by);
  RETURN NEW;
END;
$$;
