-- 2026-09-15: finance_read gains the director's business READS only.
-- Existing wage settlement marks and export rules are not modified.
ALTER TABLE role_capabilities DISABLE TRIGGER role_capabilities_no_insert;
INSERT INTO role_capabilities(role_code,capability)
SELECT 'finance_read',capability FROM role_capabilities
WHERE role_code='finance_director' AND capability IN (
  'rework:finance_nodes:read',
  'sourcing:view',
  'supplier_profile:read',
  'supplier_contract_data:read',
  'sample:view_basic',
  'sample:view_finance',
  'sample:view_audit',
  'pattern_room:prices:read',
  'pattern_room:catalog:read',
  'pattern_room:misc:quote'
) ON CONFLICT DO NOTHING;
ALTER TABLE role_capabilities ENABLE TRIGGER role_capabilities_no_insert;

CREATE OR REPLACE FUNCTION pattern_room_authorized_price_roles(actor_id uuid, requested_capability text)
RETURNS text[] LANGUAGE plpgsql STABLE AS $$
DECLARE actual_roles text[]; allowed_roles text[];
BEGIN
 actual_roles := access_authorized_actor_roles(actor_id,requested_capability);
 IF 'root_superuser'=ANY(actual_roles) THEN RETURN actual_roles; END IF;
 CASE requested_capability
 WHEN 'pattern_room:prices:read' THEN allowed_roles:=ARRAY['owner_group','production_management','finance_director','finance_read','pattern_room_supervisor']::text[];
 WHEN 'pattern_room:prices:write' THEN allowed_roles:=ARRAY['owner_group','production_management']::text[];
 WHEN 'pattern_room:hourly:write' THEN allowed_roles:=ARRAY['owner_group']::text[];
 WHEN 'pattern_room:catalog:read' THEN allowed_roles:=ARRAY['owner_group','production_management','finance_director','finance_read','pattern_room_supervisor','sample_designer']::text[];
 WHEN 'pattern_room:misc:quote' THEN allowed_roles:=ARRAY['owner_group','production_management','finance_director','finance_read','pattern_room_supervisor','sample_designer','order_merchandiser']::text[];
 ELSE RAISE EXCEPTION 'unknown pattern price capability' USING ERRCODE='42501';
 END CASE;
 IF NOT actual_roles && allowed_roles THEN RAISE EXCEPTION 'pattern price access denied' USING ERRCODE='42501'; END IF;
 RETURN actual_roles;
END $$;


-- Existing special requests also need the same immutable, actor-bound evidence guard.
CREATE OR REPLACE FUNCTION guard_external_responsibility_attachment_binding()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_case rework_external_responsibility_cases%ROWTYPE; event_record operation_events%ROWTYPE;
BEGIN
  IF OLD.entity_type='external_responsibility_case' THEN
    IF NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'bound external responsibility evidence is immutable' USING ERRCODE='55000';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.entity_type IS DISTINCT FROM 'external_responsibility_case' THEN
    RETURN NEW;
  END IF;
  IF OLD.entity_type IS NOT NULL OR OLD.entity_id IS NOT NULL OR NEW.entity_id IS NULL THEN
    RAISE EXCEPTION 'external responsibility evidence can only be bound once' USING ERRCODE='23514';
  END IF;
  SELECT * INTO target_case FROM rework_external_responsibility_cases WHERE case_id=NEW.entity_id::uuid;
  SELECT * INTO event_record FROM operation_events
  WHERE event_id=nullif(current_setting('dx_rework.external_responsibility_event_id',true),'')::uuid
    AND request_id=nullif(current_setting('dx_rework.external_responsibility_request_id',true),'');
  IF target_case.case_id IS NULL OR NEW.status<>'ready' OR event_record.event_id IS NULL
     OR NEW.uploaded_by<>event_record.actor_id OR event_record.entity_type<>'rework_order'
     OR event_record.entity_id<>target_case.rework_order_id::text
     OR event_record.action NOT IN (
       'rework.external_responsibility.submit','rework.external_responsibility.payables_return',
       'rework.external_deduction.follow_up','rework.external_deduction.record',
       'rework.external_deduction.close','rework.external_responsibility.revision.request',
       'rework.external_deduction.special.request'
     ) THEN
    RAISE EXCEPTION 'external responsibility evidence binding requires its trusted case action' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
