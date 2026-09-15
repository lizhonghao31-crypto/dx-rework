-- Verified account bindings only. Migration deliberately installs no real identities.
CREATE TABLE business_module_owner_bindings (
  member_key text PRIMARY KEY CHECK (member_key IN ('li_zhonghao','wu_yunfeng','li_junyue')),
  user_id uuid NOT NULL UNIQUE REFERENCES app_users(id),
  operation_event_id uuid NOT NULL REFERENCES operation_events(event_id),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE FUNCTION member_module_can_write(candidate uuid, module_code text) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT access_is_root_actor(candidate) OR module_code NOT IN ('rework','sourcing') OR NOT EXISTS (
    SELECT 1 FROM business_module_owner_bindings WHERE member_key='wu_yunfeng' AND user_id=candidate
  )
$$;

CREATE FUNCTION member_module_can_notify(candidate uuid, module_code text) RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT member_module_can_write(candidate,module_code) $$;

CREATE FUNCTION member_module_owner_can_approve(candidate uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
 SELECT access_is_root_actor(candidate) OR NOT EXISTS (SELECT 1 FROM business_module_owner_bindings)
   OR EXISTS (SELECT 1 FROM business_module_owner_bindings WHERE user_id=candidate AND member_key IN ('li_zhonghao','li_junyue'))
$$;

CREATE FUNCTION member_module_for_capability(capability text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
 SELECT CASE
   WHEN capability LIKE 'sourcing:%' AND capability <> 'sourcing:view' THEN 'sourcing'
   WHEN capability IN (
     'rework:initiate','process:configure','process:review','work:assign','work:assignment_adjust',
     'work:report','work:report_for_worker','quantity:adjust','quantity:confirm',
     'responsibility:determine','responsibility:takeover','responsibility:confirm_high_multiplier','responsibility:owner_sign',
     'own_factory:approve','external_responsibility:sign','external_responsibility:payables_confirm',
     'external_responsibility:request_revision','external_responsibility:approve_revision',
     'external_deduction:record','external_deduction:follow_up','external_deduction:close','external_deduction:special_approve',
     'tail_inspection:report','tail_inspection:waive','deduction:manage','external_liability:sign',
     'liability:decide','liability:takeover','task:assign'
   ) THEN 'rework' ELSE NULL END
$$;

-- Keep the original direct-role check available without re-entering the policy wrapper.
CREATE FUNCTION member_module_original_responsibility_direct_role(
  candidate uuid, required_capability text, allowed_roles text[]
) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT access_is_root_actor(candidate) OR (
    responsibility_actor_is_active(candidate) AND EXISTS (
      SELECT 1 FROM user_role_assignments assignment
      JOIN business_roles role ON role.role_code=assignment.role_code AND role.enabled=true
      JOIN role_capabilities capability ON capability.role_code=assignment.role_code
        AND capability.capability=required_capability
      WHERE assignment.user_id=candidate AND assignment.role_code=ANY(allowed_roles)
        AND assignment.revoked_at IS NULL
    )
  )
$$;

CREATE FUNCTION member_module_capability_allowed(candidate uuid, capability text) RETURNS boolean
LANGUAGE sql STABLE AS $$
 SELECT access_is_root_actor(candidate) OR (
   COALESCE(member_module_can_write(candidate,member_module_for_capability(capability)),true)
   AND (capability NOT IN ('responsibility:owner_sign','responsibility:confirm_high_multiplier','own_factory:approve','sourcing:owner:approve')
     OR member_module_owner_can_approve(candidate))
   AND (capability <> 'external_responsibility:approve_revision'
     OR member_module_owner_can_approve(candidate)
     OR member_module_original_responsibility_direct_role(candidate,capability,ARRAY['production_management']))
 )
$$;

CREATE FUNCTION member_module_for_fact(source_action text, entity_kind text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
 SELECT CASE WHEN source_action LIKE 'rework.%' OR entity_kind IN ('rework_order','external_responsibility_case') THEN 'rework'
   WHEN source_action LIKE 'sourcing.%' OR entity_kind LIKE 'sourcing_%' THEN 'sourcing' ELSE NULL END
$$;

CREATE FUNCTION member_module_for_todo_fact(source_action text, entity_kind text, source_id text) RETURNS text
LANGUAGE sql STABLE AS $$
 WITH RECURSIVE facts(action,kind,id,depth) AS (
   SELECT source_action,entity_kind,source_id,0
   UNION ALL
   SELECT t.source_action,t.entity_type,t.entity_id,f.depth+1 FROM facts f JOIN rework_todos t ON t.todo_id::text=f.id
   WHERE f.kind='rework_todo' AND f.depth<10
 ) SELECT member_module_for_fact(action,kind) FROM facts WHERE member_module_for_fact(action,kind) IS NOT NULL LIMIT 1
$$;

CREATE FUNCTION guard_member_module_operation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE module_code text;
BEGIN
  -- Technical reads and todo lifecycle audits are not business mutations.
  IF NEW.action LIKE 'todo.%' OR NEW.action LIKE 'attachment.%' OR NEW.action LIKE 'report.%'
    OR NEW.action LIKE '%.view%' OR NEW.action LIKE '%.read%' OR NEW.action LIKE '%.export%' THEN RETURN NEW; END IF;
  module_code := CASE WHEN NEW.action LIKE 'rework.%' THEN 'rework'
    WHEN NEW.action LIKE 'sourcing.%' THEN 'sourcing' ELSE NULL END;
  IF module_code IS NULL THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('member-module-owner-bindings',0));
  IF access_is_root_actor(NEW.actor_id) THEN RETURN NEW; END IF;
  IF NOT member_module_can_write(NEW.actor_id,module_code)
    OR NOT member_module_capability_allowed(NEW.actor_id,NEW.authorization_capability) THEN
    RAISE EXCEPTION 'MEMBER_MODULE_READ_ONLY: current account cannot modify this business module' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER member_module_operation_guard BEFORE INSERT ON operation_events
FOR EACH ROW EXECUTE FUNCTION guard_member_module_operation();

CREATE FUNCTION guard_member_module_binding() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE audit operation_events%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Verified member bindings are immutable; use an explicitly reviewed repair'; END IF;
  SELECT * INTO audit FROM operation_events WHERE event_id=NEW.operation_event_id;
  IF audit.action IS DISTINCT FROM 'access.member_module.bind' OR NOT access_is_root_actor(audit.actor_id)
    OR audit.after_state->>NEW.member_key IS DISTINCT FROM NEW.user_id::text THEN
    RAISE EXCEPTION 'Member bindings require a matching Root audit event' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER member_module_binding_guard BEFORE INSERT OR UPDATE OR DELETE ON business_module_owner_bindings
FOR EACH ROW EXECUTE FUNCTION guard_member_module_binding();

CREATE FUNCTION guard_member_module_todo() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.status='pending' AND (TG_OP='INSERT' OR NEW.recipient_user_id IS DISTINCT FROM OLD.recipient_user_id)
   AND NOT COALESCE(member_module_can_notify(NEW.recipient_user_id,member_module_for_todo_fact(NEW.source_action,NEW.entity_type,NEW.entity_id)),true) THEN
   RAISE EXCEPTION 'MEMBER_MODULE_READ_ONLY: recipient does not receive this module todo' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER member_module_todo_guard BEFORE INSERT OR UPDATE ON rework_todos
FOR EACH ROW EXECUTE FUNCTION guard_member_module_todo();

CREATE OR REPLACE FUNCTION external_responsibility_direct_role(candidate uuid, required_capability text, allowed_roles text[])
 RETURNS boolean
 LANGUAGE sql
 STABLE
AS $function$
  SELECT access_is_root_actor(candidate)
    OR (member_module_capability_allowed(candidate,required_capability) AND responsibility_actor_has_direct_role(candidate,required_capability,allowed_roles))
$function$;

CREATE OR REPLACE FUNCTION todo_user_has_direct_role(candidate uuid, required_role text, required_capability text)
 RETURNS boolean
 LANGUAGE sql
 STABLE
AS $function$
  SELECT access_is_root_actor(candidate)
  OR (member_module_capability_allowed(candidate,required_capability)
    AND (required_capability <> 'external_responsibility:approve_revision' OR required_role <> 'owner_group'
      OR member_module_owner_can_approve(candidate)) AND EXISTS (
    SELECT 1
    FROM user_role_assignments assignment
    JOIN business_roles role
      ON role.role_code=assignment.role_code AND role.enabled=true
    JOIN role_capabilities capability
      ON capability.role_code=assignment.role_code
     AND capability.capability=required_capability
    JOIN app_users user_record
      ON user_record.id=assignment.user_id AND user_record.enabled=true
    JOIN identity_mappings identity
      ON identity.user_id=user_record.id AND identity.provider='dingtalk'
     AND identity.active=true AND identity.employed=true
    JOIN access_security_policy policy
      ON policy.policy_key='primary'
     AND policy.dingtalk_corp_id=identity.corp_id
    WHERE assignment.user_id=candidate
      AND assignment.role_code=CASE
        WHEN required_role='tail_inspector' AND required_capability='tail_inspection:report'
          THEN 'worker'
        ELSE required_role
      END
      AND assignment.revoked_at IS NULL
  ));
$function$;

CREATE OR REPLACE FUNCTION responsibility_actor_has_direct_role(candidate uuid, required_capability text, allowed_roles text[]) RETURNS boolean
LANGUAGE sql STABLE AS $$
 SELECT access_is_root_actor(candidate) OR (member_module_capability_allowed(candidate,required_capability)
   AND member_module_original_responsibility_direct_role(candidate,required_capability,
     CASE WHEN required_capability='external_responsibility:approve_revision' AND NOT member_module_owner_can_approve(candidate)
       THEN array_remove(allowed_roles,'owner_group') ELSE allowed_roles END))
$$;

CREATE FUNCTION guard_member_binding_complete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (SELECT count(*) FROM business_module_owner_bindings) <> 3 THEN
   RAISE EXCEPTION 'All three verified members must bind atomically' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER member_bindings_complete AFTER INSERT ON business_module_owner_bindings
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION guard_member_binding_complete();
