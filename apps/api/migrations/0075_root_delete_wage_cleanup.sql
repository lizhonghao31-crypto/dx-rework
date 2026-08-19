-- Root logical deletion must remove unclosed wage facts from active business views
-- without rewriting immutable month-close history.

ALTER TABLE rework_wage_items
  ADD COLUMN invalidated_at timestamptz,
  ADD COLUMN invalidated_operation_event_id uuid REFERENCES operation_events(event_id),
  ADD COLUMN invalidated_request_id text
    CHECK(invalidated_request_id IS NULL OR length(btrim(invalidated_request_id)) BETWEEN 1 AND 200);

CREATE INDEX rework_wage_items_active_period_person_idx
  ON rework_wage_items(period_id,person_id,created_at)
  WHERE invalidated_at IS NULL;

CREATE OR REPLACE FUNCTION guard_wage_item_update()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  system_action text:=nullif(current_setting('dx_rework.wage_system_action',true),'');
  delete_event operation_events%ROWTYPE;
  period_status text;
BEGIN
  IF system_action IS DISTINCT FROM 'root_delete_cleanup' THEN
    RAISE EXCEPTION 'wage history is immutable' USING ERRCODE='55000';
  END IF;

  IF (to_jsonb(NEW) - ARRAY[
        'invalidated_at','invalidated_operation_event_id','invalidated_request_id'
      ])
     IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY[
        'invalidated_at','invalidated_operation_event_id','invalidated_request_id'
      ])
     OR OLD.invalidated_at IS NOT NULL
     OR NEW.invalidated_at IS NULL
  THEN
    RAISE EXCEPTION 'root deletion may only invalidate an active wage item'
      USING ERRCODE='23514';
  END IF;

  SELECT status INTO period_status
  FROM rework_wage_periods
  WHERE period_id=OLD.period_id;
  IF period_status='locked' THEN
    RAISE EXCEPTION 'locked wage history cannot be invalidated'
      USING ERRCODE='55000';
  END IF;

  SELECT * INTO delete_event
  FROM operation_events
  WHERE event_id=nullif(current_setting('dx_rework.rework_event_id',true),'')::uuid
    AND request_id=nullif(current_setting('dx_rework.rework_request_id',true),'')
    AND action='rework.delete'
    AND authorization_capability='rework:delete'
    AND entity_type='rework_order'
    AND entity_id=OLD.rework_order_id::text;

  IF delete_event.event_id IS NULL
     OR NEW.invalidated_operation_event_id<>delete_event.event_id
     OR NEW.invalidated_request_id<>delete_event.request_id
  THEN
    RAISE EXCEPTION 'wage invalidation requires matching root deletion event'
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER wage_items_no_update ON rework_wage_items;
CREATE TRIGGER wage_items_no_update
  BEFORE UPDATE ON rework_wage_items
  FOR EACH ROW EXECUTE FUNCTION guard_wage_item_update();

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

  SELECT count(*)::integer,
         count(DISTINCT person_id)::integer,
         COALESCE(sum(payable_amount),0)
  INTO expected_item_count,expected_people,expected_original
  FROM rework_wage_items
  WHERE period_id=NEW.period_id
    AND invalidated_at IS NULL;

  IF system_action='materialize' THEN
    IF OLD.status='locked' THEN
      RAISE EXCEPTION 'locked wage period cannot be materialized'
        USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;

  IF system_action='root_delete_cleanup' THEN
    IF OLD.status='locked'
       OR NEW.status<>'ready_to_lock'
       OR NEW.locked_by IS NOT NULL
       OR NEW.locked_at IS NOT NULL
       OR NEW.lock_note IS NOT NULL
       OR NEW.locked_operation_event_id IS NOT NULL
       OR NEW.locked_request_id IS NOT NULL
       OR NEW.source_item_count<>expected_item_count
       OR NEW.person_count<>expected_people
       OR NEW.original_total<>expected_original
       OR NEW.adjustment_total<>0
       OR NEW.final_total<>expected_original
    THEN
      RAISE EXCEPTION 'root deletion wage period totals do not match active wage facts'
        USING ERRCODE='23514';
    END IF;

    SELECT * INTO event_record
    FROM operation_events
    WHERE event_id=nullif(current_setting('dx_rework.rework_event_id',true),'')::uuid
      AND request_id=nullif(current_setting('dx_rework.rework_request_id',true),'')
      AND action='rework.delete'
      AND authorization_capability='rework:delete'
      AND entity_type='rework_order';

    IF event_record.event_id IS NULL
       OR NOT EXISTS(
         SELECT 1
         FROM rework_wage_items item
         WHERE item.period_id=NEW.period_id
           AND item.invalidated_operation_event_id=event_record.event_id
           AND item.invalidated_at IS NOT NULL
       ) THEN
      RAISE EXCEPTION 'root deletion wage cleanup requires matching deletion event'
        USING ERRCODE='55000';
    END IF;
    RETURN NEW;
  END IF;

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
     OR source_item.invalidated_at IS NOT NULL
     OR source_item.period_id<>closure_record.period_id
     OR NEW.adjustment_id IS NOT NULL
     OR NEW.person_id<>source_item.person_id
     OR NEW.original_amount<>source_item.payable_amount
     OR NEW.adjustment_amount<>0
     OR NEW.final_amount<>source_item.payable_amount THEN
    RAISE EXCEPTION 'wage closure item line does not match active source'
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
         AND invalidated_at IS NULL
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
  SET source_item_count=active.item_count,
      person_count=active.person_count,
      original_total=active.total_amount,
      adjustment_total=0,
      final_total=active.total_amount,
      status='ready_to_lock',
      period_version=period.period_version+1,
      updated_at=CURRENT_TIMESTAMP
  FROM (
    SELECT item.period_id,
           count(*)::integer AS item_count,
           count(DISTINCT item.person_id)::integer AS person_count,
           COALESCE(sum(item.payable_amount),0)::numeric(18,2) AS total_amount
    FROM rework_wage_items item
    WHERE item.invalidated_at IS NULL
    GROUP BY item.period_id
  ) active
  WHERE period.period_id=active.period_id
    AND period.period_id IN (
      SELECT DISTINCT item.period_id
      FROM rework_wage_items item
      WHERE item.order_review_id=p_order_review_id
    )
    AND period.status<>'locked'
    AND (
      period.status<>'ready_to_lock'
      OR period.source_item_count<>active.item_count
      OR period.person_count<>active.person_count
      OR period.original_total<>active.total_amount
      OR period.adjustment_total<>0
      OR period.final_total<>active.total_amount
    );
END;
$$;

CREATE OR REPLACE FUNCTION cleanup_wages_after_rework_delete()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  delete_event operation_events%ROWTYPE;
  affected_period record;
BEGIN
  IF NEW.status<>'deleted' OR OLD.status='deleted' THEN
    RETURN NEW;
  END IF;

  SELECT * INTO delete_event
  FROM operation_events
  WHERE event_id=nullif(current_setting('dx_rework.rework_event_id',true),'')::uuid
    AND request_id=nullif(current_setting('dx_rework.rework_request_id',true),'')
    AND actor_id=NEW.deleted_by
    AND action='rework.delete'
    AND authorization_capability='rework:delete'
    AND entity_type='rework_order'
    AND entity_id=NEW.rework_order_id::text;

  IF delete_event.event_id IS NULL THEN
    RAISE EXCEPTION 'wage cleanup requires trusted root deletion event'
      USING ERRCODE='55000';
  END IF;

  PERFORM set_config('dx_rework.wage_system_action','root_delete_cleanup',true);

  FOR affected_period IN
    SELECT DISTINCT period.period_id
    FROM rework_wage_items item
    JOIN rework_wage_periods period ON period.period_id=item.period_id
    WHERE item.rework_order_id=NEW.rework_order_id
      AND item.invalidated_at IS NULL
      AND period.status<>'locked'
  LOOP
    UPDATE rework_wage_items
    SET invalidated_at=CURRENT_TIMESTAMP,
        invalidated_operation_event_id=delete_event.event_id,
        invalidated_request_id=delete_event.request_id
    WHERE rework_order_id=NEW.rework_order_id
      AND period_id=affected_period.period_id
      AND invalidated_at IS NULL;

    UPDATE rework_wage_periods period
    SET source_item_count=active.item_count,
        person_count=active.person_count,
        original_total=active.total_amount,
        adjustment_total=0,
        final_total=active.total_amount,
        status='ready_to_lock',
        locked_by=NULL,
        locked_at=NULL,
        lock_note=NULL,
        locked_operation_event_id=NULL,
        locked_request_id=NULL,
        period_version=period.period_version+1,
        updated_at=CURRENT_TIMESTAMP
    FROM (
      SELECT count(*)::integer AS item_count,
             count(DISTINCT person_id)::integer AS person_count,
             COALESCE(sum(payable_amount),0)::numeric(18,2) AS total_amount
      FROM rework_wage_items
      WHERE period_id=affected_period.period_id
        AND invalidated_at IS NULL
    ) active
    WHERE period.period_id=affected_period.period_id
      AND period.status<>'locked';
  END LOOP;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS rework_orders_wage_cleanup_after_delete ON rework_orders;
CREATE TRIGGER rework_orders_wage_cleanup_after_delete
  AFTER UPDATE OF status ON rework_orders
  FOR EACH ROW
  WHEN (NEW.status='deleted' AND OLD.status IS DISTINCT FROM 'deleted')
  EXECUTE FUNCTION cleanup_wages_after_rework_delete();

-- Existing Root-deleted test orders are repaired on deployment. Locked wage
-- periods are intentionally excluded because their month-close snapshots are immutable.
ALTER TABLE rework_wage_items DISABLE TRIGGER wage_items_no_update;
UPDATE rework_wage_items item
SET invalidated_at=COALESCE(orders.deleted_at,CURRENT_TIMESTAMP)
FROM rework_orders orders
JOIN rework_wage_periods period
  ON period.status<>'locked'
WHERE item.rework_order_id=orders.rework_order_id
  AND period.period_id=item.period_id
  AND orders.status='deleted'
  AND item.invalidated_at IS NULL;
ALTER TABLE rework_wage_items ENABLE TRIGGER wage_items_no_update;

ALTER TABLE rework_wage_periods DISABLE TRIGGER wage_periods_guard_update;
WITH active AS (
  SELECT period.period_id,
         count(item.wage_item_id)::integer AS item_count,
         count(DISTINCT item.person_id)::integer AS person_count,
         COALESCE(sum(item.payable_amount),0)::numeric(18,2) AS total_amount
  FROM rework_wage_periods period
  LEFT JOIN rework_wage_items item
    ON item.period_id=period.period_id
   AND item.invalidated_at IS NULL
  WHERE period.status<>'locked'
  GROUP BY period.period_id
)
UPDATE rework_wage_periods period
SET source_item_count=active.item_count,
    person_count=active.person_count,
    original_total=active.total_amount,
    adjustment_total=0,
    final_total=active.total_amount,
    status='ready_to_lock',
    period_version=period.period_version+1,
    updated_at=CURRENT_TIMESTAMP
FROM active
WHERE period.period_id=active.period_id
  AND (
    period.status<>'ready_to_lock'
    OR period.source_item_count<>active.item_count
    OR period.person_count<>active.person_count
    OR period.original_total<>active.total_amount
    OR period.adjustment_total<>0
    OR period.final_total<>active.total_amount
  );
ALTER TABLE rework_wage_periods ENABLE TRIGGER wage_periods_guard_update;
