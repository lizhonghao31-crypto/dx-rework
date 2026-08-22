-- PR-06 Responsibility 2.0 permits a finalized external-only determination
-- to skip owner confirmation.  Its immutable source event is the canonical
-- responsibility finalization event; mixed or own-factory determinations keep
-- the owner-signature event.
CREATE OR REPLACE FUNCTION require_external_responsibility_event(
  expected_action text,
  expected_capability text,
  order_id uuid,
  persisted_actor uuid
) RETURNS operation_events LANGUAGE plpgsql AS $$
DECLARE
  event_record operation_events%ROWTYPE;
  compatible_action text;
BEGIN
  SELECT * INTO event_record
  FROM operation_events
  WHERE event_id=nullif(
      current_setting('dx_rework.external_responsibility_event_id',true),''
    )::uuid
    AND request_id=nullif(
      current_setting('dx_rework.external_responsibility_request_id',true),''
    );
  compatible_action:=CASE expected_action
    WHEN 'rework.external_responsibility.revision.approve'
      THEN 'rework.external_responsibility.revision.approved'
    WHEN 'rework.external_responsibility.revision.reject'
      THEN 'rework.external_responsibility.revision.rejected'
    WHEN 'rework.responsibility.submit_owner_signature'
      THEN 'rework.responsibility.finalize'
    ELSE NULL
  END;
  IF event_record.event_id IS NULL
     OR event_record.actor_id<>persisted_actor
     OR (
       event_record.action<>expected_action
       AND (
         compatible_action IS NULL
         OR event_record.action<>compatible_action
       )
     )
     OR event_record.authorization_capability<>expected_capability
     OR event_record.entity_type<>'rework_order'
     OR event_record.entity_id<>order_id::text THEN
    RAISE EXCEPTION 'external responsibility write requires matching trusted event'
      USING ERRCODE='55000';
  END IF;
  RETURN event_record;
END $$;

-- Replace the retired PR-05 single-party rule with PR-06 allocation rules.
-- Per-row shape is checked before insert, while the percentage total is a
-- deferred constraint so a process can be inserted as several rows inside one
-- transaction and must still finish with exactly 100 percent.
CREATE OR REPLACE FUNCTION guard_responsibility_allocation()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE schema_version smallint;
BEGIN
  SELECT determination.settlement_schema_version INTO schema_version
  FROM rework_responsibility_determinations determination
  WHERE determination.determination_id=NEW.determination_id;
  IF schema_version=2 THEN
    IF NEW.share_bps<=0 THEN
      RAISE EXCEPTION 'V2 responsibility share must be positive'
        USING ERRCODE='23514';
    END IF;
    IF NEW.responsibility_type='own_factory' AND (
      NEW.multiplier IS DISTINCT FROM 1.000 OR NEW.supplier_id IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'own-factory responsibility cannot carry an external multiplier or supplier'
        USING ERRCODE='23514';
    END IF;
    IF NEW.responsibility_type<>'own_factory' AND (
      NEW.multiplier IS NULL OR NEW.multiplier<1.200 OR NEW.supplier_id IS NULL
    ) THEN
      RAISE EXCEPTION 'external responsibility requires a supplier and multiplier of at least 1.2'
        USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS responsibility_single_party_insert
  ON rework_responsibility_allocations;
DROP TRIGGER IF EXISTS responsibility_allocation_validate_insert
  ON rework_responsibility_allocations;
CREATE TRIGGER responsibility_allocation_validate_insert
  BEFORE INSERT ON rework_responsibility_allocations
  FOR EACH ROW EXECUTE FUNCTION guard_responsibility_allocation();

CREATE OR REPLACE FUNCTION guard_responsibility_allocation_total()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_determination_id uuid:=COALESCE(NEW.determination_id,OLD.determination_id);
  target_configuration_item_id uuid:=COALESCE(NEW.configuration_item_id,OLD.configuration_item_id);
  schema_version smallint;
  allocation_count integer;
  responsibility_type_count integer;
  total_share integer;
BEGIN
  SELECT determination.settlement_schema_version INTO schema_version
  FROM rework_responsibility_determinations determination
  WHERE determination.determination_id=target_determination_id;
  IF schema_version=2 THEN
    SELECT count(*),count(DISTINCT responsibility_type),COALESCE(sum(share_bps),0)
      INTO allocation_count,responsibility_type_count,total_share
    FROM rework_responsibility_allocations
    WHERE determination_id=target_determination_id
      AND configuration_item_id=target_configuration_item_id;
    IF allocation_count<1 OR allocation_count>5
       OR allocation_count<>responsibility_type_count
       OR total_share<>10000 THEN
      RAISE EXCEPTION 'V2 process requires 1 to 5 unique responsibility parties totaling 100 percent'
        USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS responsibility_allocation_total_deferred
  ON rework_responsibility_allocations;
CREATE CONSTRAINT TRIGGER responsibility_allocation_total_deferred
  AFTER INSERT OR UPDATE OR DELETE ON rework_responsibility_allocations
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION guard_responsibility_allocation_total();

-- A V2 responsibility line snapshots the unadjusted final quantity and IE
-- price.  Temporary-worker coefficients remain solely in payable_amount and
-- must never increase a supplier deduction base.
CREATE OR REPLACE FUNCTION guard_responsibility_line()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(
    SELECT 1
    FROM rework_work_reports report
    JOIN rework_responsibility_determinations determination
      ON determination.determination_id=NEW.determination_id
    LEFT JOIN rework_work_report_rejections rejection
      ON rejection.work_report_id=report.work_report_id
    WHERE report.work_report_id=NEW.work_report_id
      AND report.status='submitted'
      AND rejection.work_report_id IS NULL
      AND report.rework_order_id=determination.rework_order_id
      AND report.configuration_item_id=NEW.configuration_item_id
      AND (
        (
          determination.settlement_schema_version=2
          AND EXISTS(
            SELECT 1
            FROM rework_wage_items wage
            WHERE wage.work_report_id=report.work_report_id
              AND wage.person_id=NEW.person_id
              AND wage.invalidated_at IS NULL
              AND round(
                wage.actual_quantity_snapshot*wage.unit_price_snapshot*
                CASE WHEN wage.assignment_mode='collective'
                  THEN 1::numeric/NULLIF(wage.member_count,0)
                  ELSE 1
                END,
                8
              )=NEW.base_member_share_amount
          )
        )
        OR (
          determination.settlement_schema_version IS DISTINCT FROM 2
          AND EXISTS(
            SELECT 1
            FROM rework_work_report_member_shares share
            WHERE share.work_report_id=report.work_report_id
              AND share.person_id=NEW.person_id
              AND share.amount=NEW.base_member_share_amount
          )
        )
      )
  ) THEN
    RAISE EXCEPTION 'amount line does not match the immutable responsibility base snapshot'
      USING ERRCODE='23514';
  END IF;
  PERFORM require_responsibility_event(
    NEW.operation_event_id,
    NEW.request_id,
    (SELECT rework_order_id FROM rework_responsibility_determinations
     WHERE determination_id=NEW.determination_id),
    (SELECT actor_id FROM operation_events WHERE event_id=NEW.operation_event_id)
  );
  RETURN NEW;
END $$;
