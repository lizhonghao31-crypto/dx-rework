-- Authorized owner parity for this business exception; audit, live identity and immutable history stay mandatory.
CREATE OR REPLACE FUNCTION guard_digital_special_closure() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT (access_is_root_actor(NEW.closed_by) OR EXISTS(SELECT 1 FROM app_users u JOIN user_role_assignments r ON r.user_id=u.id
  JOIN business_roles role ON role.role_code=r.role_code AND role.enabled
  WHERE u.id=NEW.closed_by AND u.enabled AND NOT coalesce((to_jsonb(u)->>'manual_access_disabled')::boolean,false)
  AND r.revoked_at IS NULL AND r.role_code IN ('production_management','owner_group')
  AND EXISTS(SELECT 1 FROM identity_mappings i WHERE i.user_id=u.id AND i.active AND i.employed)))
 OR NOT EXISTS(SELECT 1 FROM audit_events e WHERE e.id=NEW.audit_event_id AND e.actor_id=NEW.closed_by
  AND e.action='digital.order.special_close' AND e.entity_id=NEW.production_order_id::text)
 THEN RAISE EXCEPTION 'Only the active production director, owner or Root may special-close an order' USING ERRCODE='42501';END IF;
 RETURN NEW;
END;$$;
