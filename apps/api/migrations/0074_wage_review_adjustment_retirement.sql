-- Retire wage review and wage adjustment. Wage facts now move directly
-- from automatic materialization to month-close readiness.

-- Retire the old business capabilities without deleting catalog rows that may
-- still be referenced by immutable historical audit/todo facts.
ALTER TABLE role_capabilities DISABLE TRIGGER role_capabilities_no_delete;
DELETE FROM role_capabilities
WHERE (role_code, capability) IN (
  ('tail_supervisor', 'wage:tail_review'),
  ('tail_supervisor', 'wage:adjustment_request'),
  ('administrative_clerk', 'wage:administrative_review'),
  ('administrative_clerk', 'wage:adjustment_approve')
);
ALTER TABLE role_capabilities ENABLE TRIGGER role_capabilities_no_delete;

-- Existing unclosed months immediately become ready for month close. Historical
-- adjustment rows remain inert audit data and no longer affect payable wages.
ALTER TABLE rework_wage_periods DISABLE TRIGGER wage_periods_guard_update;
UPDATE rework_wage_periods
SET status='ready_to_lock',
    adjustment_total=0,
    final_total=original_total,
    period_version=period_version+1,
    updated_at=CURRENT_TIMESTAMP
WHERE status<>'locked'
  AND (
    status<>'ready_to_lock'
    OR adjustment_total<>0
    OR final_total<>original_total
  );
ALTER TABLE rework_wage_periods ENABLE TRIGGER wage_periods_guard_update;

-- Close obsolete wage-review/adjustment todos so retired work never remains in
-- the active work queue after this migration.
ALTER TABLE rework_todos DISABLE TRIGGER USER;
UPDATE rework_todos
SET status='cancelled',
    blocked_at=NULL,
    blocked_reason=NULL,
    cancelled_at=CURRENT_TIMESTAMP,
    cancelled_reason='工资复核与工资调整流程已取消',
    cancelled_operation_event_id=source_event_id,
    version=version+1,
    updated_at=CURRENT_TIMESTAMP
WHERE status IN ('pending','blocked_recipient')
  AND category IN (
    'wage_tail_review',
    'wage_administrative_review',
    'wage_adjustment_approval',
    'wage_tail_review_submitted',
    'wage_administrative_review_submitted',
    'wage_adjustment_requested',
    'wage_review'
  );
ALTER TABLE rework_todos ENABLE TRIGGER USER;

-- Any direct database attempt to revive the retired review/adjustment workflow
-- is rejected even though the historical tables remain for immutable audit.
CREATE OR REPLACE FUNCTION guard_wage_review_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'wage review workflow is retired' USING ERRCODE='55000';
END;
$$;

CREATE OR REPLACE FUNCTION guard_wage_adjustment_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'wage adjustment workflow is retired' USING ERRCODE='55000';
END;
$$;

CREATE OR REPLACE FUNCTION guard_wage_adjustment_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'wage adjustment workflow is retired' USING ERRCODE='55000';
END;
$$;

-- Materialization may still pass through legacy internal status values inside
-- one transaction, but its persisted result is always ready_to_lock with no
-- adjustment amount.
CREATE OR REPLACE FUNCTION guard_wage_period_update()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  system_action text:=nullif(current_setting('dx_rework.wage_system_action',true),'');
  event_record operation_events%ROWTYPE;
  expected_item_count integer;
  expected_people integer;
  expected_original numeric(18,2);
BEGIN
  IF NEW.period_id IS DISTINCT FROM OLD.period_id
     OR NEW.period_month IS DISTINCT FROM OLD.period_month
     OR NEW.timezone IS DISTINCT FROM OLD.timezone
     OR NEW.created_operation_event_id IS DISTINCT FROM OLD.created_operation_event_id
     OR NEW.created_request_id IS DISTINCT FROM OLD.created_request_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.period_version<>OLD.period_version+1 THEN
    RAISE EXCEPTION 'stable wage period facts are immutable' USING ERRCODE='55000';
  END IF;

  IF system_action='materialize' THEN
    IF OLD.status='locked' THEN
      RAISE EXCEPTION 'locked wage period cannot be materialized'
        USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;

  SELECT count(*)::integer,
         count(DISTINCT person_id)::integer,
         COALESCE(sum(payable_amount),0)
  INTO expected_item_count,expected_people,expected_original
  FROM rework_wage_items
  WHERE period_id=NEW.period_id;

  IF NEW.source_item_count<>expected_item_count
     OR NEW.person_count<>expected_people
     OR NEW.original_total<>expected_original
     OR NEW.adjustment_total<>0
     OR NEW.final_total<>expected_original THEN
    RAISE EXCEPTION 'wage period totals do not match immutable wage facts'
      USING ERRCODE='23514';
  END IF;

  SELECT * INTO event_record
  FROM operation_events
  WHERE event_id=nullif(current_setting('dx_rework.wage_event_id',true),'')::uuid;

  IF event_record.action<>'wage.month_close' THEN
    RAISE EXCEPTION 'wage period update requires month close'
      USING ERRCODE='55000';
  END IF;

  PERFORM require_wage_event(
    'wage.month_close','wage:month_close','wage_month_close_accountant',
    'wage_period',NEW.period_id::text,event_record.actor_id
  );

  IF OLD.status<>'ready_to_lock'
     OR NEW.status<>'locked'
     OR NEW.locked_by<>event_record.actor_id
     OR NEW.locked_operation_event_id<>event_record.event_id
     OR NOT EXISTS(
       SELECT 1
       FROM rework_wage_month_closures closure
       WHERE closure.period_id=NEW.period_id
         AND closure.operation_event_id=event_record.event_id
     ) THEN
    RAISE EXCEPTION 'invalid wage month-close transition'
      USING ERRCODE='23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION guard_wage_closure_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  period_record rework_wage_periods%ROWTYPE;
BEGIN
  SELECT * INTO period_record
  FROM rework_wage_periods
  WHERE period_id=NEW.period_id;

  PERFORM require_wage_event(
    'wage.month_close','wage:month_close','wage_month_close_accountant',
    'wage_period',NEW.period_id::text,NEW.locked_by
  );

  IF period_record.status<>'ready_to_lock'
     OR NEW.period_version_snapshot<>period_record.period_version
     OR NEW.item_count<>period_record.source_item_count
     OR NEW.person_count<>period_record.person_count
     OR NEW.original_total<>period_record.original_total
     OR NEW.adjustment_total<>0
     OR NEW.final_total<>period_record.original_total
     OR NEW.locked_at<(
       period_record.period_month+interval '1 month'
     ) AT TIME ZONE 'Asia/Singapore' THEN
    RAISE EXCEPTION 'wage closure does not match ready period or month boundary'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION guard_wage_close_line_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  closure_record rework_wage_month_closures%ROWTYPE;
  source_item rework_wage_items%ROWTYPE;
BEGIN
  SELECT * INTO closure_record
  FROM rework_wage_month_closures
  WHERE closure_id=NEW.closure_id;

  IF closure_record.closure_id IS NULL OR NEW.line_type<>'wage_item' THEN
    RAISE EXCEPTION 'wage close only accepts wage-item lines'
      USING ERRCODE='23514';
  END IF;

  SELECT * INTO source_item
  FROM rework_wage_items
  WHERE wage_item_id=NEW.wage_item_id;

  IF source_item.wage_item_id IS NULL
     OR source_item.period_id<>closure_record.period_id
     OR NEW.adjustment_id IS NOT NULL
     OR NEW.person_id<>source_item.person_id
     OR NEW.original_amount<>source_item.payable_amount
     OR NEW.adjustment_amount<>0
     OR NEW.final_amount<>source_item.payable_amount THEN
    RAISE EXCEPTION 'wage closure item line does not match source'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION validate_wage_closure(target_closure_id uuid)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  closure_record rework_wage_month_closures%ROWTYPE;
  wage_count bigint;
  non_wage_count bigint;
  line_total numeric(18,2);
BEGIN
  SELECT * INTO closure_record
  FROM rework_wage_month_closures
  WHERE closure_id=target_closure_id;
  IF closure_record.closure_id IS NULL THEN RETURN; END IF;

  SELECT count(*) INTO wage_count
  FROM rework_wage_month_close_lines
  WHERE closure_id=target_closure_id
    AND line_type='wage_item';

  SELECT count(*) INTO non_wage_count
  FROM rework_wage_month_close_lines
  WHERE closure_id=target_closure_id
    AND line_type<>'wage_item';

  SELECT COALESCE(sum(final_amount),0)
  INTO line_total
  FROM rework_wage_month_close_lines
  WHERE closure_id=target_closure_id;

  IF wage_count<>(
       SELECT count(*)
       FROM rework_wage_items
       WHERE period_id=closure_record.period_id
     )
     OR non_wage_count<>0
     OR closure_record.adjustment_total<>0
     OR closure_record.final_total<>closure_record.original_total
     OR line_total<>closure_record.original_total THEN
    RAISE EXCEPTION 'wage closure lines are incomplete or inconsistent'
      USING ERRCODE='23514';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION materialize_rework_wages_from_order_review_event(
  p_order_review_id uuid,
  p_event_id uuid,
  p_request_id text
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM materialize_rework_wages_from_order_review_event_review_legacy(
    p_order_review_id,
    p_event_id,
    p_request_id
  );

  PERFORM set_config('dx_rework.wage_system_action','materialize',true);

  UPDATE rework_wage_periods period
  SET status='ready_to_lock',
      adjustment_total=0,
      final_total=period.original_total,
      period_version=period.period_version+1,
      updated_at=CURRENT_TIMESTAMP
  WHERE period.period_id IN (
    SELECT DISTINCT item.period_id
    FROM rework_wage_items item
    WHERE item.order_review_id=p_order_review_id
  )
    AND period.status<>'locked'
    AND (
      period.status<>'ready_to_lock'
      OR period.adjustment_total<>0
      OR period.final_total<>period.original_total
    );
END;
$$;
