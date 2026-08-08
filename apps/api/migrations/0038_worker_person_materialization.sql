-- Keep N04 worker assignment sourced from the same employee-role facts used by access management.
-- Internal workers are materialized automatically as stable business_people records when
-- the worker role is granted. Existing worker-role users are backfilled by the immutable
-- Root identity. Temporary workers remain explicit master-data records.

CREATE OR REPLACE FUNCTION worker_business_person_id(app_user uuid)
RETURNS uuid
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
  SELECT md5('dx-rework:worker-person:' || app_user::text)::uuid
$$;

CREATE OR REPLACE FUNCTION ensure_worker_person_after_role_assignment()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_name text;
  person_id uuid;
  event_id uuid;
  request_id text;
  actor_roles text[];
  reason_text text := '授予工人角色自动建立内部作业人员档案';
BEGIN
  IF NEW.role_code <> 'worker' OR NEW.revoked_at IS NOT NULL THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1 FROM business_people person
    WHERE person.app_user_id=NEW.user_id
  ) THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM access_security_policy WHERE policy_key='primary'
  ) THEN
    RETURN NEW;
  END IF;

  SELECT u.display_name
  INTO target_name
  FROM app_users u
  JOIN identity_mappings identity
    ON identity.user_id=u.id
   AND identity.provider='dingtalk'
   AND identity.active=true
   AND identity.employed=true
  JOIN access_security_policy policy
    ON policy.policy_key='primary'
   AND policy.dingtalk_corp_id=identity.corp_id
  WHERE u.id=NEW.user_id
    AND u.enabled=true;

  IF target_name IS NULL THEN
    RAISE EXCEPTION 'worker role target is not an active employee'
      USING ERRCODE='42501';
  END IF;

  request_id := nullif(current_setting('dx_rework.role_assign_request_id', true), '');
  IF request_id IS NULL OR request_id !~ '^[A-Za-z0-9._:-]{1,128}$' THEN
    RAISE EXCEPTION 'worker person materialization requires role assignment request context'
      USING ERRCODE='55000';
  END IF;

  actor_roles := access_authorized_actor_roles(NEW.granted_by, 'master_data:manage');
  person_id := worker_business_person_id(NEW.user_id);
  event_id := md5('dx-rework:worker-person-event:' || NEW.assignment_id::text)::uuid;

  INSERT INTO operation_events(
    event_id,request_id,actor_id,actor_roles,authorization_capability,
    action,entity_type,entity_id,after_state,reason
  ) VALUES (
    event_id,request_id,NEW.granted_by,actor_roles,'master_data:manage',
    'master_data.person.create','business_person',person_id::text,
    jsonb_build_object(
      'personType','internal',
      'appUserId',NEW.user_id,
      'displayName',target_name,
      'active',true,
      'aliases','[]'::jsonb
    ),
    reason_text
  );

  PERFORM set_config('dx_rework.person_create_event_id',event_id::text,true);
  PERFORM set_config('dx_rework.person_create_request_id',request_id,true);

  INSERT INTO business_people(
    person_id,person_type,app_user_id,display_name,created_by
  ) VALUES (
    person_id,'internal',NEW.user_id,target_name,NEW.granted_by
  );

  RETURN NEW;
END
$$;

CREATE TRIGGER user_role_assignments_materialize_worker_person
  AFTER INSERT ON user_role_assignments
  FOR EACH ROW
  EXECUTE FUNCTION ensure_worker_person_after_role_assignment();

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
    event_id := md5('dx-rework:worker-person-backfill-event:' || row_record.user_id::text)::uuid;

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

    PERFORM set_config('dx_rework.person_create_event_id',event_id::text,true);
    PERFORM set_config('dx_rework.person_create_request_id',request_id,true);

    INSERT INTO business_people(
      person_id,person_type,app_user_id,display_name,created_by
    ) VALUES (
      person_id,'internal',row_record.user_id,row_record.display_name,root_id
    );
  END LOOP;
END
$$;

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
