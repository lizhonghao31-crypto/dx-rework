-- Root-only logical deletion for sourcing cases. Business reads hide the
-- case, while attachments, decisions, transitions and audit events remain.

ALTER TABLE sourcing_cases
  ADD COLUMN deleted_at timestamptz,
  ADD COLUMN deleted_by uuid REFERENCES app_users(id),
  ADD COLUMN deletion_operation_event_id uuid UNIQUE REFERENCES operation_events(event_id),
  ADD COLUMN deletion_request_id text
    CHECK(deletion_request_id IS NULL OR deletion_request_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  ADD COLUMN deletion_reason text
    CHECK(deletion_reason IS NULL OR length(btrim(deletion_reason)) BETWEEN 1 AND 500),
  ADD CONSTRAINT sourcing_cases_deletion_metadata_check CHECK (
    (deleted_at IS NULL AND deleted_by IS NULL
      AND deletion_operation_event_id IS NULL
      AND deletion_request_id IS NULL AND deletion_reason IS NULL)
    OR
    (deleted_at IS NOT NULL AND deleted_by IS NOT NULL
      AND deletion_operation_event_id IS NOT NULL
      AND deletion_request_id IS NOT NULL AND deletion_reason IS NOT NULL)
  );

ALTER TABLE sourcing_cases
  DROP CONSTRAINT sourcing_cases_erp_order_id_lane_key_key;
CREATE UNIQUE INDEX sourcing_cases_active_erp_lane_unique
  ON sourcing_cases(erp_order_id,lane_key)
  WHERE deleted_at IS NULL;

CREATE OR REPLACE FUNCTION guard_sourcing_case_deletion_metadata_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.deleted_at IS NOT NULL OR NEW.deleted_by IS NOT NULL
    OR NEW.deletion_operation_event_id IS NOT NULL
    OR NEW.deletion_request_id IS NOT NULL OR NEW.deletion_reason IS NOT NULL THEN
    RAISE EXCEPTION 'new sourcing cases cannot start deleted'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER sourcing_cases_guard_deletion_metadata_insert
  BEFORE INSERT ON sourcing_cases FOR EACH ROW
  EXECUTE FUNCTION guard_sourcing_case_deletion_metadata_insert();

DROP TRIGGER sourcing_cases_no_update ON sourcing_cases;
CREATE OR REPLACE FUNCTION guard_sourcing_case_logical_deletion()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'deleted sourcing cases are immutable'
      USING ERRCODE='55000';
  END IF;
  IF NEW.deleted_at IS NULL OR NEW.deleted_by IS NULL
    OR NEW.deletion_operation_event_id IS NULL
    OR NEW.deletion_request_id IS NULL OR NEW.deletion_reason IS NULL
    OR (to_jsonb(NEW) - ARRAY[
      'deleted_at','deleted_by','deletion_operation_event_id',
      'deletion_request_id','deletion_reason'
    ]) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY[
      'deleted_at','deleted_by','deletion_operation_event_id',
      'deletion_request_id','deletion_reason'
    ]) THEN
    RAISE EXCEPTION 'logical deletion may only set deletion metadata'
      USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM operation_events event
    WHERE event.event_id=NEW.deletion_operation_event_id
      AND event.request_id=NEW.deletion_request_id
      AND event.actor_id=NEW.deleted_by
      AND event.action='sourcing.case.delete'
      AND event.authorization_capability='sourcing:delete'
      AND event.entity_type='sourcing_case'
      AND event.entity_id=NEW.sourcing_case_id::text
      AND event.reason IS NOT DISTINCT FROM NEW.deletion_reason
  ) THEN
    RAISE EXCEPTION 'sourcing deletion requires its immutable operation event'
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER sourcing_cases_guard_logical_deletion
  BEFORE UPDATE ON sourcing_cases FOR EACH ROW
  EXECUTE FUNCTION guard_sourcing_case_logical_deletion();

CREATE OR REPLACE VIEW current_sourcing_cases AS
  SELECT
    sourcing_case.sourcing_case_id,
    sourcing_case.erp_order_id,
    sourcing_case.erp_order_no,
    sourcing_case.style_no,
    sourcing_case.lane_key,
    sourcing_case.order_quantity,
    current_transition.to_status AS status,
    current_transition.sequence AS version,
    sourcing_case.created_by,
    sourcing_case.created_at,
    current_transition.transitioned_at AS updated_at,
    sourcing_case.delivery_date,
    sourcing_case.process_description
  FROM sourcing_cases sourcing_case
  JOIN LATERAL (
    SELECT transition_row.to_status,transition_row.sequence,transition_row.transitioned_at
    FROM sourcing_case_transitions transition_row
    WHERE transition_row.sourcing_case_id=sourcing_case.sourcing_case_id
    ORDER BY transition_row.sequence DESC
    LIMIT 1
  ) current_transition ON true
  WHERE sourcing_case.deleted_at IS NULL;

CREATE OR REPLACE FUNCTION sourcing_current_status(required_case_id uuid)
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT transition_row.to_status
  FROM sourcing_case_transitions transition_row
  JOIN sourcing_cases source_case
    ON source_case.sourcing_case_id=transition_row.sourcing_case_id
   AND source_case.deleted_at IS NULL
  WHERE transition_row.sourcing_case_id=required_case_id
  ORDER BY transition_row.sequence DESC
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION guard_active_sourcing_transition_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM sourcing_cases source_case
    WHERE source_case.sourcing_case_id=NEW.sourcing_case_id
      AND source_case.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'deleted sourcing cases cannot receive new transitions'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER sourcing_transitions_require_active_case
  BEFORE INSERT ON sourcing_case_transitions FOR EACH ROW
  EXECUTE FUNCTION guard_active_sourcing_transition_insert();
