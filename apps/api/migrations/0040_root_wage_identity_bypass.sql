-- Root single-account acceptance must not be blocked by actor-separation rules
-- that exist only to protect ordinary business users. Keep all wage state,
-- amount, version, immutability and evidence-readiness rules unchanged.

CREATE OR REPLACE FUNCTION guard_wage_adjustment_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  source_item rework_wage_items%ROWTYPE;
  target_period rework_wage_periods%ROWTYPE;
BEGIN
  PERFORM require_wage_event(
    'wage.adjustment.request','wage:adjustment_request','tail_supervisor',
    'wage_adjustment',NEW.adjustment_id::text,NEW.requested_by
  );
  SELECT * INTO source_item
  FROM rework_wage_items
  WHERE wage_item_id=NEW.original_wage_item_id;
  SELECT * INTO target_period
  FROM rework_wage_periods
  WHERE period_id=NEW.target_period_id;
  IF source_item.wage_item_id IS NULL
     OR target_period.period_id IS NULL
     OR target_period.status='locked'
     OR NEW.person_id<>source_item.person_id
     OR NEW.target_period_version_snapshot<>target_period.period_version
     OR (
       source_item.period_id<>target_period.period_id
       AND NOT EXISTS(
         SELECT 1
         FROM rework_wage_periods source_period
         WHERE source_period.period_id=source_item.period_id
           AND source_period.status='locked'
           AND target_period.period_month>source_period.period_month
       )
     ) THEN
    RAISE EXCEPTION 'invalid wage adjustment source or target period'
      USING ERRCODE='23514';
  END IF;
  IF cardinality(NEW.attachment_ids)<>cardinality(
       ARRAY(
         SELECT DISTINCT attachment_value
         FROM unnest(NEW.attachment_ids) AS evidence(attachment_value)
       )
     ) OR EXISTS(
       SELECT 1
       FROM unnest(NEW.attachment_ids) AS evidence(attachment_value)
       LEFT JOIN attachments attachment
         ON attachment.attachment_id=evidence.attachment_value
       WHERE attachment.attachment_id IS NULL
          OR attachment.status<>'ready'
          OR (
            attachment.uploaded_by<>NEW.requested_by
            AND NOT access_is_root_actor(NEW.requested_by)
          )
          OR attachment.entity_type IS NOT NULL
          OR attachment.entity_id IS NOT NULL
     ) THEN
    RAISE EXCEPTION 'wage adjustment attachments must be ready and unbound'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION guard_wage_adjustment_update()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  expected_action text;
  period_status text;
  person_total numeric(18,2);
BEGIN
  IF NEW.adjustment_id IS DISTINCT FROM OLD.adjustment_id
     OR NEW.original_wage_item_id IS DISTINCT FROM OLD.original_wage_item_id
     OR NEW.target_period_id IS DISTINCT FROM OLD.target_period_id
     OR NEW.target_period_version_snapshot
        IS DISTINCT FROM OLD.target_period_version_snapshot
     OR NEW.person_id IS DISTINCT FROM OLD.person_id
     OR NEW.adjustment_amount IS DISTINCT FROM OLD.adjustment_amount
     OR NEW.reason IS DISTINCT FROM OLD.reason
     OR NEW.attachment_ids IS DISTINCT FROM OLD.attachment_ids
     OR NEW.requested_by IS DISTINCT FROM OLD.requested_by
     OR NEW.requested_at IS DISTINCT FROM OLD.requested_at
     OR NEW.request_operation_event_id IS DISTINCT FROM OLD.request_operation_event_id
     OR NEW.request_operation_request_id
        IS DISTINCT FROM OLD.request_operation_request_id
     OR OLD.status<>'pending'
     OR NEW.status NOT IN ('approved','rejected')
     OR NEW.version<>OLD.version+1
     OR NEW.decided_by IS NULL
     OR NEW.decided_at IS NULL THEN
    RAISE EXCEPTION 'wage adjustment history is immutable except one decision'
      USING ERRCODE='55000';
  END IF;
  expected_action:=CASE NEW.status
    WHEN 'approved' THEN 'wage.adjustment.approve'
    ELSE 'wage.adjustment.reject'
  END;
  PERFORM require_wage_event(
    expected_action,'wage:adjustment_approve','administrative_clerk',
    'wage_adjustment',NEW.adjustment_id::text,NEW.decided_by
  );
  IF NEW.decided_by=OLD.requested_by
     AND NOT access_is_root_actor(NEW.decided_by) THEN
    RAISE EXCEPTION 'adjustment requester cannot decide own request'
      USING ERRCODE='42501';
  END IF;
  SELECT status INTO period_status
  FROM rework_wage_periods WHERE period_id=NEW.target_period_id;
  IF period_status='locked' THEN
    RAISE EXCEPTION 'locked wage period cannot accept adjustment decision'
      USING ERRCODE='23514';
  END IF;
  IF NEW.status='approved' THEN
    SELECT
      COALESCE((
        SELECT sum(item.payable_amount)
        FROM rework_wage_items item
        WHERE item.period_id=NEW.target_period_id
          AND item.person_id=NEW.person_id
      ),0)
      + COALESCE((
        SELECT sum(adjustment.adjustment_amount)
        FROM rework_wage_adjustments adjustment
        WHERE adjustment.target_period_id=NEW.target_period_id
          AND adjustment.person_id=NEW.person_id
          AND adjustment.status='approved'
          AND adjustment.adjustment_id<>NEW.adjustment_id
      ),0)
      + NEW.adjustment_amount
    INTO person_total;
    IF person_total<0 THEN
      RAISE EXCEPTION 'approved adjustment would make wage negative'
        USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION guard_wage_attachment_update()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_adjustment rework_wage_adjustments%ROWTYPE;
BEGIN
  IF OLD.entity_type='wage_adjustment'
     AND (OLD.entity_type,OLD.entity_id)
       IS NOT DISTINCT FROM (NEW.entity_type,NEW.entity_id) THEN
    IF NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'bound wage evidence is immutable' USING ERRCODE='55000';
    END IF;
    RETURN NEW;
  END IF;
  IF (OLD.entity_type,OLD.entity_id)
       IS NOT DISTINCT FROM (NEW.entity_type,NEW.entity_id)
     OR (OLD.entity_type IS DISTINCT FROM 'wage_adjustment'
       AND NEW.entity_type IS DISTINCT FROM 'wage_adjustment') THEN
    RETURN NEW;
  END IF;
  IF NOT (
    OLD.entity_type IS NULL AND OLD.entity_id IS NULL
    AND NEW.entity_type='wage_adjustment' AND NEW.entity_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'wage evidence cannot be moved or unbound'
      USING ERRCODE='55000';
  END IF;
  SELECT * INTO target_adjustment
  FROM rework_wage_adjustments
  WHERE adjustment_id=NEW.entity_id::uuid;
  IF target_adjustment.adjustment_id IS NULL
     OR NEW.status<>'ready'
     OR (
       NEW.uploaded_by<>target_adjustment.requested_by
       AND NOT access_is_root_actor(target_adjustment.requested_by)
     )
     OR NEW.attachment_id<>ALL(target_adjustment.attachment_ids) THEN
    RAISE EXCEPTION 'attachment is not authorized for wage adjustment'
      USING ERRCODE='42501';
  END IF;
  PERFORM require_wage_event(
    'wage.adjustment.request','wage:adjustment_request','tail_supervisor',
    'wage_adjustment',NEW.entity_id,target_adjustment.requested_by
  );
  RETURN NEW;
END;
$$;
