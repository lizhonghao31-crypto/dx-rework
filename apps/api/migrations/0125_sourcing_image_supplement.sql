-- Keep sourcing image evidence append-only and bind every image through a matching audit event.
CREATE OR REPLACE FUNCTION guard_sourcing_attachment_binding() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  audit_event_id text := nullif(current_setting('dx_rework.sourcing_event_id', true), '');
  audit_request_id text := nullif(current_setting('dx_rework.sourcing_request_id', true), '');
  source_case_id uuid;
BEGIN
  IF OLD.entity_type='sourcing_case' THEN
    IF NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'bound sourcing evidence is immutable' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF (OLD.entity_type,OLD.entity_id) IS NOT DISTINCT FROM (NEW.entity_type,NEW.entity_id)
     OR (OLD.entity_type IS DISTINCT FROM 'sourcing_case' AND NEW.entity_type IS DISTINCT FROM 'sourcing_case')
  THEN
    RETURN NEW;
  END IF;

  IF audit_event_id IS NULL OR audit_request_id IS NULL THEN
    RAISE EXCEPTION 'sourcing attachment binding requires trusted audit context' USING ERRCODE = '55000';
  END IF;
  IF NOT (
    OLD.entity_type IS NULL
    AND OLD.entity_id IS NULL
    AND NEW.entity_type='sourcing_case'
    AND NEW.entity_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'sourcing attachments cannot be moved or detached' USING ERRCODE = '23514';
  END IF;

  source_case_id := NEW.entity_id::uuid;
  IF NOT EXISTS (
    SELECT 1
    FROM sourcing_cases source_case
    WHERE source_case.sourcing_case_id=source_case_id
      AND source_case.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'sourcing case does not exist for attachment binding' USING ERRCODE = '23514';
  END IF;
  IF NEW.status<>'ready' THEN
    RAISE EXCEPTION 'only ready sourcing images can be bound' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM operation_events event
    WHERE event.event_id=audit_event_id::uuid
      AND event.request_id=audit_request_id
      AND event.actor_id=NEW.uploaded_by
      AND event.entity_type='sourcing_case'
      AND event.entity_id=source_case_id::text
      AND event.after_state->'attachmentIds' ? NEW.attachment_id::text
      AND (
        (
          event.action='sourcing.case.create'
          AND event.authorization_capability='sourcing:inquiry:create'
        )
        OR (
          event.action='sourcing.attachments.supplement'
          AND event.authorization_capability='tools:user'
        )
      )
  ) THEN
    RAISE EXCEPTION 'sourcing attachment audit event does not match the binding' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sourcing_attachment_binding_guard ON attachments;
CREATE TRIGGER sourcing_attachment_binding_guard
BEFORE UPDATE ON attachments
FOR EACH ROW EXECUTE FUNCTION guard_sourcing_attachment_binding();

CREATE OR REPLACE FUNCTION guard_sourcing_attachment_delete()
RETURNS trigger LANGUAGE plpgsql AS $
BEGIN
  IF OLD.entity_type='sourcing_case' THEN
    RAISE EXCEPTION 'bound sourcing evidence cannot be deleted' USING ERRCODE = '55000';
  END IF;
  RETURN OLD;
END;
$;

DROP TRIGGER IF EXISTS sourcing_attachment_delete_guard ON attachments;
CREATE TRIGGER sourcing_attachment_delete_guard
BEFORE DELETE ON attachments
FOR EACH ROW EXECUTE FUNCTION guard_sourcing_attachment_delete();

CREATE OR REPLACE FUNCTION guard_sourcing_attachment_truncate()
RETURNS trigger LANGUAGE plpgsql AS $
BEGIN
  RAISE EXCEPTION 'attachment evidence cannot be truncated' USING ERRCODE = '55000';
END;
$;

DROP TRIGGER IF EXISTS sourcing_attachment_truncate_guard ON attachments;
CREATE TRIGGER sourcing_attachment_truncate_guard
BEFORE TRUNCATE ON attachments
FOR EACH STATEMENT EXECUTE FUNCTION guard_sourcing_attachment_truncate();
