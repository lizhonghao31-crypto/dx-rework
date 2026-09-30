-- Root logical deletion: preserve labor, attachments, wage snapshots and paid markers.
ALTER TABLE capability_catalog DISABLE TRIGGER capability_catalog_no_insert;
INSERT INTO capability_catalog(capability,display_name,description) VALUES
 ('pattern_room:orders:delete','删除板房订单','Root 逻辑删除打板和杂事订单，保留审计与原始工资事实');
ALTER TABLE capability_catalog ENABLE TRIGGER capability_catalog_no_insert;

ALTER TABLE pattern_room_orders
 ADD COLUMN deleted_at timestamptz,
 ADD COLUMN deleted_by uuid REFERENCES app_users(id),
 ADD COLUMN deletion_event_id uuid REFERENCES operation_events(event_id),
 ADD CONSTRAINT pattern_order_deletion_complete CHECK (
  (deleted_at IS NULL AND deleted_by IS NULL AND deletion_event_id IS NULL)
  OR (deleted_at IS NOT NULL AND deleted_by IS NOT NULL AND deletion_event_id IS NOT NULL));
CREATE INDEX pattern_room_live_orders ON pattern_room_orders(submitted_at DESC,order_id DESC) WHERE deleted_at IS NULL;

CREATE OR REPLACE FUNCTION pattern_room_authorized_order_roles(actor_id uuid, requested_capability text)
RETURNS text[] LANGUAGE plpgsql STABLE AS $$
DECLARE actual_roles text[]; allowed_roles text[];
BEGIN
 actual_roles:=access_authorized_actor_roles(actor_id,requested_capability);
 IF 'root_superuser'=ANY(actual_roles) THEN RETURN actual_roles; END IF;
 CASE requested_capability
 WHEN 'pattern_room:orders:delete' THEN allowed_roles:=ARRAY['root_superuser']::text[];
 WHEN 'pattern_room:orders:view' THEN allowed_roles:=ARRAY['sample_designer','order_merchandiser','pattern_room_supervisor','pattern_room_worker','owner_group','production_management','wage_month_close_accountant','finance_director','finance_read']::text[];
 WHEN 'pattern_room:orders:create' THEN allowed_roles:=ARRAY['sample_designer']::text[];
 WHEN 'pattern_room:orders:assign' THEN allowed_roles:=ARRAY['pattern_room_supervisor']::text[];
 WHEN 'pattern_room:orders:complete' THEN allowed_roles:=ARRAY['pattern_room_worker']::text[];
 WHEN 'pattern_room:orders:handoff' THEN allowed_roles:=ARRAY['sample_designer']::text[];
 WHEN 'pattern_room:orders:edit' THEN allowed_roles:=ARRAY['sample_designer']::text[];
 WHEN 'pattern_room:misc:create' THEN allowed_roles:=ARRAY['sample_designer','order_merchandiser']::text[];
 WHEN 'pattern_room:misc:edit' THEN allowed_roles:=ARRAY['sample_designer','order_merchandiser']::text[];
 WHEN 'pattern_room:misc:confirm' THEN allowed_roles:=ARRAY['sample_designer','order_merchandiser']::text[];
 WHEN 'pattern_room:orders:hours' THEN allowed_roles:=ARRAY['pattern_room_supervisor']::text[];
 WHEN 'pattern_room:orders:rework' THEN allowed_roles:=ARRAY['sample_designer','pattern_room_supervisor']::text[];
 WHEN 'pattern_room:orders:transfer' THEN allowed_roles:=ARRAY['pattern_room_supervisor']::text[];
 WHEN 'pattern_room:orders:cancel' THEN allowed_roles:=ARRAY['sample_designer','order_merchandiser','pattern_room_supervisor']::text[];
 WHEN 'pattern_room:orders:cancel_fees' THEN allowed_roles:=ARRAY['sample_designer']::text[];
 ELSE RAISE EXCEPTION 'unknown pattern order capability' USING ERRCODE='42501';
 END CASE;
 IF NOT actual_roles && allowed_roles THEN RAISE EXCEPTION 'pattern order access denied' USING ERRCODE='42501'; END IF;
 RETURN actual_roles;
END $$;

CREATE FUNCTION guard_pattern_order_deletion() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE roles text[];
BEGIN
 IF TG_OP='UPDATE' THEN
  IF OLD.deleted_at IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
   RAISE EXCEPTION 'deleted pattern order is immutable' USING ERRCODE='55000';
  END IF;
  IF (NEW.deleted_at,NEW.deleted_by,NEW.deletion_event_id) IS NOT DISTINCT FROM (OLD.deleted_at,OLD.deleted_by,OLD.deletion_event_id) THEN RETURN NEW; END IF;
 END IF;
 IF NEW.deleted_at IS NULL THEN
  IF TG_OP='INSERT' THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'pattern order deletion cannot be undone' USING ERRCODE='55000';
 END IF;
 roles:=pattern_room_authorized_order_roles(NEW.deleted_by,'pattern_room:orders:delete');
 IF NOT 'root_superuser'=ANY(roles) OR NOT EXISTS(
  SELECT 1 FROM operation_events e WHERE e.event_id=NEW.deletion_event_id
   AND e.actor_id=NEW.deleted_by AND e.action='pattern_room.order.deleted'
   AND e.entity_type='pattern_room_order' AND e.entity_id=NEW.order_id::text
 ) THEN RAISE EXCEPTION 'pattern order deletion requires Root audit' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER pattern_room_order_deletion_guard BEFORE INSERT OR UPDATE ON pattern_room_orders
 FOR EACH ROW EXECUTE FUNCTION guard_pattern_order_deletion();

-- The order lock serializes a paid marker against deletion without mutating wage facts.
-- A selection made before a racing deletion cannot insert a new mark after deletion commits.
CREATE FUNCTION guard_live_pattern_settlement_mark() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.pattern_wage_item_id IS NULL THEN RETURN NEW; END IF;
 PERFORM o.order_id FROM pattern_room_wage_items w JOIN pattern_room_orders o ON o.order_id=w.order_id
  WHERE w.wage_item_id=NEW.pattern_wage_item_id AND o.deleted_at IS NULL FOR SHARE OF o;
 IF NOT FOUND THEN RETURN NULL; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER wage_settlement_live_pattern_guard BEFORE INSERT ON rework_wage_settlement_marks
 FOR EACH ROW EXECUTE FUNCTION guard_live_pattern_settlement_mark();
