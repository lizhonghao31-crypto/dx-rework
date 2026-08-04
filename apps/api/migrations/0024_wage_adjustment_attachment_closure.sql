-- PR-12 reviewed closure: disambiguate and lock wage adjustment evidence.

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
          OR attachment.uploaded_by<>NEW.requested_by
          OR attachment.entity_type IS NOT NULL
          OR attachment.entity_id IS NOT NULL
     ) THEN
    RAISE EXCEPTION 'wage adjustment attachments must be ready and unbound'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
