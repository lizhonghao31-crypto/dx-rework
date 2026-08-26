-- Keep the special tail-inspection step outside the public process catalog while
-- giving it the same explicit, versioned default-worker workflow as a process.

CREATE TABLE tail_inspection_default_worker_roster_versions (
  roster_version integer PRIMARY KEY CHECK(roster_version>0),
  person_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  change_reason text NOT NULL CHECK(length(btrim(change_reason)) BETWEEN 1 AND 500),
  changed_by uuid NOT NULL REFERENCES app_users(id),
  operation_event_id uuid NOT NULL UNIQUE REFERENCES operation_events(event_id),
  changed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK(cardinality(person_ids)<=200)
);

CREATE OR REPLACE FUNCTION guard_tail_inspection_default_worker_roster_version()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF cardinality(NEW.person_ids) <> (
    SELECT count(DISTINCT person_id) FROM unnest(NEW.person_ids) AS person(person_id)
  ) THEN
    RAISE EXCEPTION 'tail default worker roster contains duplicate people' USING ERRCODE='23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM unnest(NEW.person_ids) AS selected(person_id)
    LEFT JOIN business_people person ON person.person_id=selected.person_id
    WHERE person.person_id IS NULL OR person.active=false OR NOT (
      person.person_type='temporary'
      OR (
        person.person_type='internal'
        AND EXISTS (
          SELECT 1
          FROM app_users app_user
          JOIN identity_mappings identity
            ON identity.user_id=app_user.id
           AND identity.provider='dingtalk'
           AND identity.active=true
           AND identity.employed=true
          JOIN access_security_policy policy
            ON policy.policy_key='primary'
           AND policy.dingtalk_corp_id=identity.corp_id
          JOIN user_role_assignments assignment
            ON assignment.user_id=app_user.id
           AND assignment.role_code IN ('worker','tail_inspector')
           AND assignment.revoked_at IS NULL
          JOIN business_roles role
            ON role.role_code=assignment.role_code
           AND role.enabled=true
          JOIN role_capabilities capability
            ON capability.role_code=assignment.role_code
           AND capability.capability='tail_inspection:report'
          WHERE app_user.id=person.app_user_id
            AND app_user.enabled=true
        )
      )
    )
  ) THEN
    RAISE EXCEPTION 'tail default worker roster contains an ineligible person' USING ERRCODE='23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM operation_events event
    WHERE event.event_id=NEW.operation_event_id
      AND event.actor_id=NEW.changed_by
      AND event.authorization_capability IN ('master_data:manage','process:configure')
      AND event.actor_roles=access_authorized_actor_roles(NEW.changed_by,event.authorization_capability)
      AND event.action='master_data.tail_default_workers.replace'
      AND event.entity_type='tail_inspection_default_worker_roster'
      AND event.entity_id='tail_inspection'
      AND (event.after_state->>'rosterVersion')::integer=NEW.roster_version
      AND event.after_state->'personIds'=to_jsonb(NEW.person_ids)
      AND event.reason=NEW.change_reason
  ) THEN
    RAISE EXCEPTION 'tail default worker roster requires matching audit event' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER tail_inspection_default_worker_roster_guard_insert
  BEFORE INSERT ON tail_inspection_default_worker_roster_versions
  FOR EACH ROW EXECUTE FUNCTION guard_tail_inspection_default_worker_roster_version();
CREATE TRIGGER tail_inspection_default_worker_roster_no_update
  BEFORE UPDATE ON tail_inspection_default_worker_roster_versions
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER tail_inspection_default_worker_roster_no_delete
  BEFORE DELETE ON tail_inspection_default_worker_roster_versions
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER tail_inspection_default_worker_roster_no_truncate
  BEFORE TRUNCATE ON tail_inspection_default_worker_roster_versions
  FOR EACH STATEMENT EXECUTE FUNCTION reject_operation_event_mutation();
