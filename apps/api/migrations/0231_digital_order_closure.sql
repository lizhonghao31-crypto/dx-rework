-- Exceptions record a decision, never rewrite original quantities or financial facts.
CREATE TABLE digital_order_closures(
 production_order_id uuid PRIMARY KEY REFERENCES digital_production_orders(production_order_id),
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 2000),
 outstanding jsonb NOT NULL CHECK(jsonb_typeof(outstanding)='array'),
 source_revision text NOT NULL CHECK(source_revision ~ '^[a-f0-9]{64}$'),
 closed_by uuid NOT NULL REFERENCES app_users(id),closed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 audit_event_id uuid NOT NULL REFERENCES audit_events(id)
);
CREATE TRIGGER digital_order_closure_immutable BEFORE UPDATE OR DELETE ON digital_order_closures FOR EACH ROW EXECUTE FUNCTION guard_production_order_root_immutable();
CREATE FUNCTION guard_digital_special_closure() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT (access_is_root_actor(NEW.closed_by) OR EXISTS(SELECT 1 FROM app_users u JOIN user_role_assignments r ON r.user_id=u.id
  JOIN business_roles role ON role.role_code=r.role_code AND role.enabled
  WHERE u.id=NEW.closed_by AND u.enabled AND NOT coalesce((to_jsonb(u)->>'manual_access_disabled')::boolean,false)
  AND r.revoked_at IS NULL AND r.role_code='production_management'
  AND EXISTS(SELECT 1 FROM identity_mappings i WHERE i.user_id=u.id AND i.active AND i.employed)))
 OR NOT EXISTS(SELECT 1 FROM audit_events e WHERE e.id=NEW.audit_event_id AND e.actor_id=NEW.closed_by
  AND e.action='digital.order.special_close' AND e.entity_id=NEW.production_order_id::text)
 THEN RAISE EXCEPTION 'Only the active production director or Root may special-close an order' USING ERRCODE='42501';END IF;
 RETURN NEW;
END;$$;
CREATE TRIGGER digital_special_closure_authorized BEFORE INSERT ON digital_order_closures FOR EACH ROW EXECUTE FUNCTION guard_digital_special_closure();
