-- Bosses may confirm their own high-multiplier determination. Root remains a
-- global business bypass and is also an explicit recipient of shared boss
-- todos without requiring an ordinary user_role_assignments row.

CREATE OR REPLACE FUNCTION todo_user_has_direct_role(
  candidate uuid,
  required_role text,
  required_capability text
) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT access_is_root_actor(candidate)
  OR EXISTS (
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
      AND assignment.role_code=required_role
      AND assignment.revoked_at IS NULL
  );
$$;

CREATE OR REPLACE FUNCTION guard_responsibility_confirmation_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  determination rework_responsibility_determinations%ROWTYPE;
  order_status text;
  current_leaf uuid;
  expected_snapshot jsonb;
BEGIN
  SELECT *
  INTO determination
  FROM rework_responsibility_determinations
  WHERE determination_id = NEW.determination_id
  FOR SHARE;

  IF determination.determination_id IS NULL THEN
    RAISE EXCEPTION 'responsibility determination does not exist'
      USING ERRCODE = '23503';
  END IF;

  SELECT status INTO order_status
  FROM rework_orders
  WHERE rework_order_id = determination.rework_order_id
  FOR SHARE;

  SELECT leaf.determination_id
  INTO current_leaf
  FROM rework_responsibility_determinations leaf
  WHERE leaf.rework_order_id = determination.rework_order_id
    AND NOT EXISTS (
      SELECT 1
      FROM rework_responsibility_determinations successor
      WHERE successor.replaces_determination_id = leaf.determination_id
    );

  IF order_status <> 'pending_responsibility_determination'
     OR determination.stage <> 'draft'
     OR current_leaf IS DISTINCT FROM determination.determination_id THEN
    RAISE EXCEPTION 'only the current pending draft may be confirmed'
      USING ERRCODE = '23514';
  END IF;

  IF NOT responsibility_actor_has_direct_role(
    NEW.confirmed_by,
    'responsibility:confirm_high_multiplier',
    ARRAY['owner_group']
  ) THEN
    RAISE EXCEPTION 'high multiplier confirmation requires a direct active owner or root'
      USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM rework_responsibility_processes process
    WHERE process.determination_id = NEW.determination_id
      AND process.multiplier > 2
  ) THEN
    RAISE EXCEPTION 'determination has no high multiplier process'
      USING ERRCODE = '23514';
  END IF;

  SELECT jsonb_build_object(
    'determinationId', determination.determination_id,
    'determinationVersion', determination.determination_version,
    'submittedBy', determination.created_by,
    'handlerUserId', responsibility_effective_handler(determination.rework_order_id),
    'processes', COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'configurationItemId', process.configuration_item_id,
          'multiplier', process.multiplier::text,
          'highMultiplierReason', process.high_multiplier_reason
        )
        ORDER BY process.configuration_item_id
      ) FILTER (WHERE process.configuration_item_id IS NOT NULL),
      '[]'::jsonb
    )
  )
  INTO expected_snapshot
  FROM rework_responsibility_processes process
  WHERE process.determination_id = determination.determination_id
    AND process.multiplier > 2;

  IF NEW.confirmation_snapshot IS DISTINCT FROM expected_snapshot THEN
    RAISE EXCEPTION 'high multiplier confirmation snapshot does not match the draft'
      USING ERRCODE = '23514';
  END IF;

  PERFORM require_responsibility_event(
    NEW.operation_event_id,
    NEW.request_id,
    determination.rework_order_id,
    NEW.confirmed_by
  );

  RETURN NEW;
END
$$;
