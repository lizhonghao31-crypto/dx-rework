-- PR-10: versioned default worker roster for public process catalog items.

CREATE TABLE process_default_worker_roster_versions (
  process_id uuid NOT NULL REFERENCES process_catalog_items(process_id),
  roster_version integer NOT NULL CHECK(roster_version>0),
  person_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  change_reason text NOT NULL CHECK(length(btrim(change_reason)) BETWEEN 1 AND 500),
  changed_by uuid NOT NULL REFERENCES app_users(id),
  operation_event_id uuid NOT NULL UNIQUE REFERENCES operation_events(event_id),
  changed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(process_id,roster_version),
  CHECK(cardinality(person_ids)<=200)
);

CREATE OR REPLACE FUNCTION guard_process_default_worker_roster_version()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected_roles text[];
BEGIN
  IF cardinality(NEW.person_ids) <> (
    SELECT count(DISTINCT person_id) FROM unnest(NEW.person_ids) AS person(person_id)
  ) THEN
    RAISE EXCEPTION 'default worker roster contains duplicate people' USING ERRCODE='23514';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM unnest(NEW.person_ids) AS selected(person_id)
    LEFT JOIN business_people person ON person.person_id=selected.person_id
    WHERE person.person_id IS NULL OR person.active=false OR NOT (
      person.person_type='temporary'
      OR EXISTS (
        SELECT 1 FROM user_role_assignments assignment
        WHERE assignment.user_id=person.app_user_id
          AND assignment.role_code='worker' AND assignment.revoked_at IS NULL
      )
    )
  ) THEN
    RAISE EXCEPTION 'default worker roster contains an ineligible person' USING ERRCODE='23514';
  END IF;
  expected_roles := access_authorized_actor_roles(NEW.changed_by,'master_data:manage');
  IF NOT EXISTS (
    SELECT 1 FROM operation_events event
    WHERE event.event_id=NEW.operation_event_id
      AND event.actor_id=NEW.changed_by
      AND event.actor_roles=expected_roles
      AND event.authorization_capability='master_data:manage'
      AND event.action='master_data.process_default_workers.replace'
      AND event.entity_type='process_default_worker_roster'
      AND event.entity_id=NEW.process_id::text
      AND (event.after_state->>'rosterVersion')::integer=NEW.roster_version
      AND event.after_state->'personIds'=to_jsonb(NEW.person_ids)
      AND event.reason=NEW.change_reason
  ) THEN
    RAISE EXCEPTION 'default worker roster requires matching audit event' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER process_default_worker_roster_guard_insert
  BEFORE INSERT ON process_default_worker_roster_versions
  FOR EACH ROW EXECUTE FUNCTION guard_process_default_worker_roster_version();
CREATE TRIGGER process_default_worker_roster_no_update
  BEFORE UPDATE ON process_default_worker_roster_versions
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER process_default_worker_roster_no_delete
  BEFORE DELETE ON process_default_worker_roster_versions
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER process_default_worker_roster_no_truncate
  BEFORE TRUNCATE ON process_default_worker_roster_versions
  FOR EACH STATEMENT EXECUTE FUNCTION reject_operation_event_mutation();
