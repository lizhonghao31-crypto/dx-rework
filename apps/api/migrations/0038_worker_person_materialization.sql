-- Align N04 assignment people with the employee-role source of truth.
-- New worker-role grants are provisioned by WorkerAwareAccessMasterDataService.
-- This migration only backfills already-existing worker roles and adds a hard
-- assignment-time eligibility guard. Temporary workers remain explicit records.

CREATE OR REPLACE FUNCTION worker_business_person_id(app_user uuid)
RETURNS uuid
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
  SELECT md5('dx-rework:worker-person:' || app_user::text)::uuid
$$;

-- Backfill is a reviewed migration. Disable only the business-person creation
-- trigger while inserting rows because the migration writes the matching audit
-- event explicitly. The normal trigger is restored immediately afterwards.
DROP TRIGGER business_people_guard_creation ON business_people;

DO $$
DECLARE
  root_id uuid;
  root_roles text[];
  row_record record;
  person_id uuid;
  event_id uuid;
  request_id text := 'migration-0038-worker-backfill';
  reason_text text := '0038 自动补齐既有工人内部作业人员档案';
BEGIN
  SELECT root.user_id
  INTO root_id
  FROM owner_bootstrap_consumptions root
  WHERE root.singleton=true
  LIMIT 1;

  IF root_id IS NULL OR NOT access_is_root_actor(root_id) THEN
    RETURN;
  END IF;

  root_roles := access_authorized_actor_roles(root_id, 'master_data:manage');

  FOR row_record IN
    SELECT DISTINCT u.id user_id,u.display_name
    FROM user_role_assignments assignment
    JOIN app_users u
      ON u.id=assignment.user_id
     AND u.enabled=true
    JOIN identity_mappings identity
      ON identity.user_id=u.id
     AND identity.provider='dingtalk'
     AND identity.active=true
     AND identity.employed=true
    JOIN access_security_policy policy
      ON policy.policy_key='primary'
     AND policy.dingtalk_corp_id=identity.corp_id
    WHERE assignment.role_code='worker'
      AND assignment.revoked_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM business_people person
        WHERE person.app_user_id=u.id
      )
    ORDER BY u.id
  LOOP
    person_id := worker_business_person_id(row_record.user_id);
    event_id := md5(
      'dx-rework:worker-person-backfill-event:' || row_record.user_id::text
    )::uuid;

    INSERT INTO operation_events(
      event_id,request_id,actor_id,actor_roles,authorization_capability,
      action,entity_type,entity_id,after_state,reason
    ) VALUES (
      event_id,request_id,root_id,root_roles,'master_data:manage',
      'master_data.person.create','business_person',person_id::text,
      jsonb_build_object(
        'personType','internal',
        'appUserId',row_record.user_id,
        'displayName',row_record.display_name,
        'active',true,
        'aliases','[]'::jsonb
      ),
      reason_text
    );

    INSERT INTO business_people(
      person_id,person_type,app_user_id,display_name,created_by
    ) VALUES (
      person_id,'internal',row_record.user_id,row_record.display_name,root_id
    );
  END LOOP;
END
$$;

CREATE TRIGGER business_people_guard_creation
  BEFORE INSERT ON business_people
  FOR EACH ROW
  EXECUTE FUNCTION guard_business_person_creation();

CREATE OR REPLACE FUNCTION guard_work_task_member_employee_eligibility()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  person_record business_people%ROWTYPE;
BEGIN
  SELECT *
  INTO person_record
  FROM business_people
  WHERE person_id=NEW.person_id;

  IF person_record.person_id IS NULL OR person_record.active IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'work task member must reference an active business person'
      USING ERRCODE='42501';
  END IF;

  IF person_record.person_type='internal' AND NOT EXISTS (
    SELECT 1
    FROM app_users u
    JOIN identity_mappings identity
      ON identity.user_id=u.id
     AND identity.provider='dingtalk'
     AND identity.active=true
     AND identity.employed=true
    JOIN access_security_policy policy
      ON policy.policy_key='primary'
     AND policy.dingtalk_corp_id=identity.corp_id
    JOIN user_role_assignments assignment
      ON assignment.user_id=u.id
     AND assignment.role_code='worker'
     AND assignment.revoked_at IS NULL
    JOIN business_roles role
      ON role.role_code=assignment.role_code
     AND role.enabled=true
    WHERE u.id=person_record.app_user_id
      AND u.enabled=true
  ) THEN
    RAISE EXCEPTION 'internal work task member is no longer an active eligible worker'
      USING ERRCODE='42501';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER rework_work_task_members_employee_eligibility
  BEFORE INSERT ON rework_work_task_members
  FOR EACH ROW
  EXECUTE FUNCTION guard_work_task_member_employee_eligibility();
