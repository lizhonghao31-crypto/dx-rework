-- First pattern flow: source records only; no wage ledger integration or ordinary-user activation.
ALTER TABLE capability_catalog DISABLE TRIGGER capability_catalog_no_insert;
ALTER TABLE role_capabilities DISABLE TRIGGER role_capabilities_no_insert;
INSERT INTO capability_catalog(capability,display_name,description) VALUES
 ('pattern_room:orders:view','查看板房订单','订单打板专属操作；范围由订单归属控制'),
 ('pattern_room:orders:create','创建打板订单','订单打板专属操作；范围由订单归属控制'),
 ('pattern_room:orders:assign','板房派工','订单打板专属操作；范围由订单归属控制'),
 ('pattern_room:orders:complete','板房工人完工','订单打板专属操作；范围由订单归属控制'),
 ('pattern_room:orders:handoff','确认样板交接','订单打板专属操作；范围由订单归属控制'),
 ('pattern_room:orders:edit','维护制作资料','订单打板专属操作；范围由订单归属控制') ON CONFLICT DO NOTHING;
INSERT INTO role_capabilities(role_code,capability) VALUES
 ('sample_designer','pattern_room:orders:view'),
 ('pattern_room_supervisor','pattern_room:orders:view'),
 ('worker','pattern_room:orders:view'),
 ('owner_group','pattern_room:orders:view'),
 ('production_management','pattern_room:orders:view'),
 ('sample_designer','pattern_room:orders:create'),
 ('pattern_room_supervisor','pattern_room:orders:assign'),
 ('worker','pattern_room:orders:complete'),
 ('sample_designer','pattern_room:orders:handoff'),
 ('sample_designer','pattern_room:orders:edit'),
 ('pattern_room_supervisor','todo:view') ON CONFLICT DO NOTHING;
ALTER TABLE role_capabilities ENABLE TRIGGER role_capabilities_no_insert;
ALTER TABLE capability_catalog ENABLE TRIGGER capability_catalog_no_insert;

CREATE FUNCTION pattern_room_authorized_order_roles(actor_id uuid, requested_capability text)
RETURNS text[] LANGUAGE plpgsql STABLE AS $$
DECLARE actual_roles text[]; allowed_roles text[];
BEGIN
 actual_roles:=access_authorized_actor_roles(actor_id,requested_capability);
 IF 'root_superuser'=ANY(actual_roles) THEN RETURN actual_roles; END IF;
 CASE requested_capability
 WHEN 'pattern_room:orders:view' THEN allowed_roles:=ARRAY['sample_designer','pattern_room_supervisor','worker','owner_group','production_management']::text[];
 WHEN 'pattern_room:orders:create' THEN allowed_roles:=ARRAY['sample_designer']::text[];
 WHEN 'pattern_room:orders:assign' THEN allowed_roles:=ARRAY['pattern_room_supervisor']::text[];
 WHEN 'pattern_room:orders:complete' THEN allowed_roles:=ARRAY['worker']::text[];
 WHEN 'pattern_room:orders:handoff' THEN allowed_roles:=ARRAY['sample_designer']::text[];
 WHEN 'pattern_room:orders:edit' THEN allowed_roles:=ARRAY['sample_designer']::text[];
 ELSE RAISE EXCEPTION 'unknown pattern order capability' USING ERRCODE='42501';
 END CASE;
 IF NOT actual_roles && allowed_roles THEN RAISE EXCEPTION 'pattern order access denied' USING ERRCODE='42501'; END IF;
 RETURN actual_roles;
END $$;

CREATE SEQUENCE pattern_room_order_number;
CREATE TABLE pattern_room_orders (
 order_id uuid PRIMARY KEY,
 order_no text NOT NULL UNIQUE DEFAULT ('BF-'||to_char(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai','YYYYMMDD')||'-'||nextval('pattern_room_order_number')::text),
 kind text NOT NULL DEFAULT 'pattern' CHECK(kind='pattern'),
 status text NOT NULL CHECK(status IN ('pending_assignment','in_progress','pending_confirmation','completed','cancelled')),
 version integer NOT NULL DEFAULT 1 CHECK(version>0), current_round_id uuid NOT NULL,
 created_by uuid NOT NULL REFERENCES app_users(id), creator_name text NOT NULL,
 style_no text NOT NULL CHECK(length(btrim(style_no)) BETWEEN 1 AND 100),
 required_date date, customer text, size_color text, reference_style_no text, variant text, note text,
 submitted_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 completed_at timestamptz, cancelled_at timestamptz, rework_count integer NOT NULL DEFAULT 0 CHECK(rework_count>=0)
);
CREATE INDEX pattern_room_order_creator_idx ON pattern_room_orders(created_by,submitted_at DESC,order_id);
CREATE INDEX pattern_room_order_status_idx ON pattern_room_orders(status,submitted_at DESC,order_id);
CREATE TABLE pattern_room_rounds (
 round_id uuid PRIMARY KEY, order_id uuid NOT NULL REFERENCES pattern_room_orders(order_id),
 round_index integer NOT NULL DEFAULT 0 CHECK(round_index>=0),
 status text NOT NULL CHECK(status IN ('pending_assignment','in_progress','pending_confirmation','completed','cancelled')),
 category_id uuid NOT NULL, price_version integer NOT NULL,
 category_name text NOT NULL, unit text NOT NULL CHECK(unit IN ('件','套')),
 unit_price numeric(14,3) NOT NULL CHECK(unit_price>=0), quantity integer NOT NULL CHECK(quantity>0),
 agreed_amount numeric(20,3) NOT NULL CHECK(agreed_amount>=0),
 requested_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 assigned_at timestamptz, assigned_by uuid REFERENCES app_users(id),
 supervisor_user_id uuid REFERENCES app_users(id), completed_at timestamptz,
 handed_over_at timestamptz, handed_over_by uuid REFERENCES app_users(id),
 UNIQUE(round_id,order_id), UNIQUE(order_id,round_index),
 FOREIGN KEY(category_id,price_version) REFERENCES pattern_room_price_history(price_id,version),
 CHECK((handed_over_at IS NULL)=(handed_over_by IS NULL)),
 CHECK(handed_over_at IS NULL OR completed_at IS NOT NULL)
);
ALTER TABLE pattern_room_orders ADD CONSTRAINT pattern_room_current_round_fk
 FOREIGN KEY(current_round_id,order_id) REFERENCES pattern_room_rounds(round_id,order_id) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE pattern_room_segments (
 segment_id uuid PRIMARY KEY, round_id uuid NOT NULL REFERENCES pattern_room_rounds(round_id),
 segment_index integer NOT NULL CHECK(segment_index>0), person_id uuid NOT NULL REFERENCES business_people(person_id),
 worker_user_id uuid NOT NULL REFERENCES app_users(id), worker_name text NOT NULL, person_type text NOT NULL CHECK(person_type='internal'),
 amount numeric(20,3) NOT NULL CHECK(amount>=0), started_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 ended_at timestamptz, worker_completed_at timestamptz, wage_eligible_at timestamptz,
 UNIQUE(round_id,segment_index),
 CHECK(ended_at IS NULL OR ended_at>=started_at),
 CHECK(worker_completed_at IS NULL OR ended_at IS NOT NULL),
 CHECK(wage_eligible_at IS NULL OR ended_at IS NOT NULL)
);
CREATE UNIQUE INDEX pattern_room_one_current_worker ON pattern_room_segments(round_id) WHERE ended_at IS NULL;
CREATE INDEX pattern_room_worker_orders_idx ON pattern_room_segments(worker_user_id,round_id);
CREATE TABLE pattern_room_node_times (
 node_id uuid PRIMARY KEY, round_id uuid NOT NULL REFERENCES pattern_room_rounds(round_id),
 stage text NOT NULL CHECK(stage IN ('pending_assignment','in_progress','pending_confirmation')),
 entered_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP, exited_at timestamptz,
 exit_reason text CHECK(exit_reason IN ('completed','rework','cancelled')),
 UNIQUE(round_id,stage), CHECK((exited_at IS NULL)=(exit_reason IS NULL)), CHECK(exited_at IS NULL OR exited_at>=entered_at)
);
CREATE UNIQUE INDEX pattern_room_one_open_node ON pattern_room_node_times(round_id) WHERE exited_at IS NULL;
CREATE TABLE pattern_room_attachment_bindings (
 order_id uuid NOT NULL, round_id uuid NOT NULL,
 attachment_id uuid NOT NULL REFERENCES attachments(attachment_id), active boolean NOT NULL DEFAULT true,
 bound_by uuid NOT NULL REFERENCES app_users(id), bound_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 reason text NOT NULL CHECK(length(btrim(reason))>0), PRIMARY KEY(round_id,attachment_id),
 FOREIGN KEY(round_id,order_id) REFERENCES pattern_room_rounds(round_id,order_id)
);
CREATE INDEX pattern_room_attachment_lookup ON pattern_room_attachment_bindings(attachment_id);
CREATE TRIGGER pattern_room_orders_no_delete BEFORE DELETE ON pattern_room_orders
 FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER pattern_room_attachments_no_delete BEFORE DELETE ON pattern_room_attachment_bindings
 FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();

ALTER TABLE rework_todos DROP CONSTRAINT rework_todos_route_descriptor_check;
ALTER TABLE rework_todos ADD CONSTRAINT rework_todos_route_descriptor_check CHECK(
 jsonb_typeof(route_descriptor)='object' AND route_descriptor ? 'routeName' AND route_descriptor ? 'entityId'
 AND route_descriptor->>'routeName' IN ('rework_detail','process_configuration','whole_order_review','responsibility_detail',
 'own_factory_approval','external_responsibility_detail','wage_period_detail','sourcing_detail','production_detail','sample_detail','pattern_room_order')
 AND length(btrim(route_descriptor->>'entityId'))>0
);
