-- Remove the retired wage-review gate from the database contract.
-- Wage materialization and approved adjustments stay immediately ready for month close.

ALTER FUNCTION materialize_rework_wages_from_order_review_event(uuid,uuid,text)
  RENAME TO materialize_rework_wages_from_order_review_event_review_legacy;

CREATE OR REPLACE FUNCTION guard_wage_period_update()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  system_action text:=nullif(current_setting('dx_rework.wage_system_action',true),'');
  event_record operation_events%ROWTYPE;
  expected_item_count integer;
  expected_people integer;
  expected_original numeric(18,2);
  expected_adjustment numeric(18,2);
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
  SELECT count(*)::integer,count(DISTINCT person_id)::integer,
         COALESCE(sum(payable_amount),0)
  INTO expected_item_count,expected_people,expected_original
  FROM rework_wage_items WHERE period_id=NEW.period_id;
  SELECT COALESCE(sum(adjustment_amount),0) INTO expected_adjustment
  FROM rework_wage_adjustments
  WHERE target_period_id=NEW.period_id AND status='approved';
  IF NEW.source_item_count<>expected_item_count
     OR NEW.person_count<>expected_people
     OR NEW.original_total<>expected_original
     OR NEW.adjustment_total<>expected_adjustment
     OR NEW.final_total<>expected_original+expected_adjustment THEN
    RAISE EXCEPTION 'wage period totals do not match immutable facts'
      USING ERRCODE='23514';
  END IF;
  IF system_action='materialize' THEN
    IF OLD.status='locked'
       OR NEW.status NOT IN ('pending_tail_review','ready_to_lock') THEN
      RAISE EXCEPTION 'invalid wage materialization update' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO event_record FROM operation_events
  WHERE event_id=nullif(current_setting('dx_rework.wage_event_id',true),'')::uuid;
  IF event_record.action='wage.tail_approve' THEN
    PERFORM require_wage_event('wage.tail_approve','wage:tail_review',
      'tail_supervisor','wage_period',NEW.period_id::text,event_record.actor_id);
    IF OLD.status<>'pending_tail_review' OR NEW.status<>'pending_admin_review' THEN
      RAISE EXCEPTION 'invalid tail review transition' USING ERRCODE='23514';
    END IF;
  ELSIF event_record.action='wage.administrative_approve' THEN
    PERFORM require_wage_event('wage.administrative_approve',
      'wage:administrative_review','administrative_clerk','wage_period',
      NEW.period_id::text,event_record.actor_id);
    IF OLD.status<>'pending_admin_review' OR NEW.status<>'ready_to_lock' THEN
      RAISE EXCEPTION 'invalid administrative review transition' USING ERRCODE='23514';
    END IF;
  ELSIF event_record.action='wage.administrative_return' THEN
    PERFORM require_wage_event('wage.administrative_return',
      'wage:administrative_review','administrative_clerk','wage_period',
      NEW.period_id::text,event_record.actor_id);
    IF OLD.status<>'pending_admin_review' OR NEW.status<>'pending_tail_review' THEN
      RAISE EXCEPTION 'invalid administrative return transition' USING ERRCODE='23514';
    END IF;
  ELSIF event_record.action='wage.adjustment.approve' THEN
    PERFORM require_wage_event('wage.adjustment.approve','wage:adjustment_approve',
      'administrative_clerk','wage_adjustment',event_record.entity_id,
      event_record.actor_id);
    IF OLD.status='locked' OR NEW.status<>'ready_to_lock' THEN
      RAISE EXCEPTION 'approved adjustment must remain ready for month close'
        USING ERRCODE='23514';
    END IF;
  ELSIF event_record.action='wage.month_close' THEN
    PERFORM require_wage_event('wage.month_close','wage:month_close',
      'wage_month_close_accountant','wage_period',NEW.period_id::text,
      event_record.actor_id);
    IF OLD.status<>'ready_to_lock' OR NEW.status<>'locked'
       OR NEW.locked_by<>event_record.actor_id
       OR NEW.locked_operation_event_id<>event_record.event_id
       OR NOT EXISTS(SELECT 1 FROM rework_wage_month_closures closure
         WHERE closure.period_id=NEW.period_id
           AND closure.operation_event_id=event_record.event_id) THEN
      RAISE EXCEPTION 'invalid wage month-close transition' USING ERRCODE='23514';
    END IF;
  ELSE
    RAISE EXCEPTION 'wage period update requires recognized action'
      USING ERRCODE='55000';
  END IF;
  IF event_record.action<>'wage.month_close'
     AND (NEW.locked_by,NEW.locked_at,NEW.lock_note,
          NEW.locked_operation_event_id,NEW.locked_request_id)
       IS DISTINCT FROM
         (OLD.locked_by,OLD.locked_at,OLD.lock_note,
          OLD.locked_operation_event_id,OLD.locked_request_id) THEN
    RAISE EXCEPTION 'lock facts may only change during month close'
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
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

  UPDATE rework_wage_periods period SET
    status='ready_to_lock',
    period_version=period.period_version+1,
    updated_at=CURRENT_TIMESTAMP
  WHERE period.period_id IN (
    SELECT DISTINCT item.period_id
    FROM rework_wage_items item
    WHERE item.order_review_id=p_order_review_id
  )
    AND period.status='pending_tail_review';
END;
$$;
