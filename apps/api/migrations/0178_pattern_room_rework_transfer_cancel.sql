-- Extend only the existing pattern-room workflow; completed labor and history remain intact.
ALTER TABLE capability_catalog DISABLE TRIGGER capability_catalog_no_insert;
ALTER TABLE role_capabilities DISABLE TRIGGER role_capabilities_no_insert;
INSERT INTO capability_catalog(capability,display_name,description) VALUES
 ('pattern_room:orders:rework','发起原单打板返工','原设计师或板房主管发起新轮次'),
 ('pattern_room:orders:transfer','板房原单换人','主管确认原执行段劳动归属后转交'),
 ('pattern_room:orders:cancel','取消板房任务','未派工由发起人、派工后由主管停止本单'),
 ('pattern_room:orders:cancel_fees','确认打板取消费用','原设计师确认取消费用，不伪造样板交接') ON CONFLICT DO NOTHING;
INSERT INTO role_capabilities(role_code,capability) VALUES
 ('sample_designer','pattern_room:orders:rework'),('pattern_room_supervisor','pattern_room:orders:rework'),
 ('pattern_room_supervisor','pattern_room:orders:transfer'),
 ('sample_designer','pattern_room:orders:cancel'),('order_merchandiser','pattern_room:orders:cancel'),('pattern_room_supervisor','pattern_room:orders:cancel'),
 ('sample_designer','pattern_room:orders:cancel_fees') ON CONFLICT DO NOTHING;
ALTER TABLE role_capabilities ENABLE TRIGGER role_capabilities_no_insert;
ALTER TABLE capability_catalog ENABLE TRIGGER capability_catalog_no_insert;

CREATE OR REPLACE FUNCTION pattern_room_authorized_order_roles(actor_id uuid, requested_capability text)
RETURNS text[] LANGUAGE plpgsql STABLE AS $$
DECLARE actual_roles text[]; allowed_roles text[];
BEGIN
 actual_roles:=access_authorized_actor_roles(actor_id,requested_capability);
 IF 'root_superuser'=ANY(actual_roles) THEN RETURN actual_roles; END IF;
 CASE requested_capability
 WHEN 'pattern_room:orders:view' THEN allowed_roles:=ARRAY['sample_designer','order_merchandiser','pattern_room_supervisor','worker','owner_group','production_management']::text[];
 WHEN 'pattern_room:orders:create' THEN allowed_roles:=ARRAY['sample_designer']::text[];
 WHEN 'pattern_room:orders:assign' THEN allowed_roles:=ARRAY['pattern_room_supervisor']::text[];
 WHEN 'pattern_room:orders:complete' THEN allowed_roles:=ARRAY['worker']::text[];
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

ALTER TABLE pattern_room_rounds ADD COLUMN round_type text NOT NULL DEFAULT 'initial' CHECK(round_type IN ('initial','rework'));
ALTER TABLE pattern_room_rounds ADD COLUMN requested_by uuid REFERENCES app_users(id);
UPDATE pattern_room_rounds round SET requested_by=orders.created_by FROM pattern_room_orders orders WHERE orders.order_id=round.order_id;
ALTER TABLE pattern_room_rounds ALTER COLUMN requested_by SET NOT NULL;
ALTER TABLE pattern_room_rounds ADD COLUMN request_reason text;
ALTER TABLE pattern_room_rounds ADD COLUMN reason_category text CHECK(reason_category IN ('customer_change','workmanship','other'));
ALTER TABLE pattern_room_rounds ALTER COLUMN round_index DROP NOT NULL;
ALTER TABLE pattern_room_rounds ALTER COLUMN unit_price DROP NOT NULL;
ALTER TABLE pattern_room_rounds ADD COLUMN stopped_at timestamptz;
ALTER TABLE pattern_room_rounds ADD COLUMN cancelled_at timestamptz;
ALTER TABLE pattern_room_rounds ADD COLUMN cancelled_by uuid REFERENCES app_users(id);
ALTER TABLE pattern_room_rounds ADD COLUMN cancel_reason text;
ALTER TABLE pattern_room_rounds ADD COLUMN cancelled_amount numeric(26,8) CHECK(cancelled_amount>=0);
ALTER TABLE pattern_room_rounds ADD COLUMN fee_confirmed_at timestamptz;
ALTER TABLE pattern_room_rounds ADD COLUMN fee_confirmed_by uuid REFERENCES app_users(id);
ALTER TABLE pattern_room_rounds DROP CONSTRAINT pattern_room_round_pricing_basis_check;
ALTER TABLE pattern_room_rounds ADD CONSTRAINT pattern_room_round_pricing_basis_check CHECK(
 (round_type='initial' AND round_index=0 AND unit_price IS NOT NULL AND
   ((unit IN ('件','套') AND quantity IS NOT NULL AND agreed_amount IS NOT NULL AND actual_hours IS NULL) OR (unit='小时' AND quantity IS NULL)))
 OR (round_type='rework' AND unit='轮' AND quantity IS NULL AND unit_price IS NULL AND actual_hours IS NULL
   AND request_reason IS NOT NULL AND length(btrim(request_reason))>0 AND reason_category IS NOT NULL
   AND ((assigned_at IS NULL AND round_index IS NULL) OR (assigned_at IS NOT NULL AND round_index>0 AND agreed_amount IS NOT NULL))));
ALTER TABLE pattern_room_rounds DROP CONSTRAINT pattern_room_rounds_actual_hours_check;
ALTER TABLE pattern_room_rounds ADD CONSTRAINT pattern_room_rounds_actual_hours_check CHECK(
 actual_hours>=0 AND actual_hours<=999999.9 AND actual_hours=trunc(actual_hours,1)
 AND (actual_hours>0 OR cancelled_at IS NOT NULL));
ALTER TABLE pattern_room_rounds ADD CONSTRAINT pattern_room_round_cancellation_check CHECK(
 (cancelled_at IS NULL AND cancelled_by IS NULL AND cancel_reason IS NULL AND cancelled_amount IS NULL)
 OR (cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL AND cancel_reason IS NOT NULL AND length(btrim(cancel_reason))>0 AND cancelled_amount IS NOT NULL AND status='cancelled'));
ALTER TABLE pattern_room_rounds ADD CONSTRAINT pattern_room_round_fee_confirmation_check CHECK(
 (fee_confirmed_at IS NULL AND fee_confirmed_by IS NULL)
 OR (fee_confirmed_at IS NOT NULL AND fee_confirmed_by IS NOT NULL AND cancelled_at IS NOT NULL AND handed_over_at IS NULL));
ALTER TABLE pattern_room_orders ADD COLUMN cancelled_by uuid REFERENCES app_users(id);
ALTER TABLE pattern_room_orders ADD COLUMN cancel_reason text;
