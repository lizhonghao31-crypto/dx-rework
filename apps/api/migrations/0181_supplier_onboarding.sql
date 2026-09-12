ALTER TABLE capability_catalog DISABLE TRIGGER capability_catalog_no_insert;
ALTER TABLE role_capabilities DISABLE TRIGGER role_capabilities_no_insert;
INSERT INTO capability_catalog(capability,display_name,description) VALUES
 ('supplier_onboarding:request','新增供应商申请','跟单提交与修改本人退回申请'),
 ('supplier_onboarding:approve','新增供应商审批','老板和生产管理审批或退回申请');
INSERT INTO role_capabilities(role_code,capability) VALUES
 ('order_merchandiser','supplier_onboarding:request'),('embroidery_washing_merchandiser','supplier_onboarding:request'),
 ('owner_group','supplier_onboarding:approve'),('production_management','supplier_onboarding:approve'),
 ('embroidery_washing_merchandiser','supplier_profile:read'),('embroidery_washing_merchandiser','todo:view') ON CONFLICT DO NOTHING;
ALTER TABLE capability_catalog ENABLE TRIGGER capability_catalog_no_insert;
ALTER TABLE role_capabilities ENABLE TRIGGER role_capabilities_no_insert;

CREATE FUNCTION supplier_onboarding_authorized_roles(actor_id uuid, mode text) RETURNS text[] LANGUAGE plpgsql AS $$
DECLARE roles text[];
BEGIN
 IF mode NOT IN ('request','approve') THEN RAISE EXCEPTION 'unknown supplier application authority' USING ERRCODE='42501'; END IF;
 roles := access_authorized_actor_roles(actor_id,'supplier_onboarding:'||mode);
 IF mode='request' THEN
  IF roles && ARRAY['root_superuser','owner_group','production_management'] OR NOT (roles && ARRAY['order_merchandiser','embroidery_washing_merchandiser']) THEN
   RAISE EXCEPTION 'use direct maintenance or an authorized applicant role' USING ERRCODE='42501';
  END IF;
 ELSIF NOT (roles && ARRAY['root_superuser','owner_group','production_management']) THEN
  RAISE EXCEPTION 'supplier approval requires owner or production' USING ERRCODE='42501';
 END IF;
 RETURN roles;
END; $$;
CREATE TABLE supplier_onboarding_requests (
 request_id uuid PRIMARY KEY, applicant_id uuid NOT NULL REFERENCES app_users(id), applicant_name text NOT NULL,
 status text NOT NULL CHECK(status IN ('pending_approval','returned','approved')),
 current_version integer NOT NULL CHECK(current_version>0), supplier_id uuid UNIQUE REFERENCES supplier_catalog_items(supplier_id),
 created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK((status='approved')=(supplier_id IS NOT NULL))
);
CREATE TABLE supplier_onboarding_request_versions (
 request_id uuid NOT NULL REFERENCES supplier_onboarding_requests(request_id), version integer NOT NULL CHECK(version>0),
 profile jsonb NOT NULL CHECK(jsonb_typeof(profile)='object' AND profile->>'supplierType' IN ('factory','embroidery_washing','fabric','other')
  AND length(btrim(profile->>'supplierName')) BETWEEN 1 AND 200 AND profile->>'active'='true'),
 submitted_by uuid NOT NULL REFERENCES app_users(id), submitted_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(request_id,version)
);
ALTER TABLE supplier_onboarding_requests ADD CONSTRAINT supplier_onboarding_current_version_fk
 FOREIGN KEY(request_id,current_version) REFERENCES supplier_onboarding_request_versions(request_id,version) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE supplier_onboarding_decisions (
 decision_id uuid PRIMARY KEY, request_id uuid NOT NULL, version integer NOT NULL,
 decision text NOT NULL CHECK(decision IN ('approved','returned')), reason text,
 reviewer_id uuid NOT NULL REFERENCES app_users(id), reviewer_name text NOT NULL,
 supplier_id uuid REFERENCES supplier_catalog_items(supplier_id), decided_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(request_id,version), FOREIGN KEY(request_id,version) REFERENCES supplier_onboarding_request_versions(request_id,version),
 CHECK((decision='approved')=(supplier_id IS NOT NULL)),
 CHECK(decision<>'returned' OR (reason IS NOT NULL AND length(btrim(reason)) BETWEEN 1 AND 500))
);
CREATE INDEX supplier_onboarding_applicant_idx ON supplier_onboarding_requests(applicant_id,updated_at DESC);
CREATE INDEX supplier_onboarding_pending_idx ON supplier_onboarding_requests(updated_at DESC) WHERE status='pending_approval';

-- Shares the formal catalog lock: submission and approval cannot miss a concurrent formal creation.
CREATE FUNCTION assert_supplier_onboarding_identity(candidate jsonb, excluded_request uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtext('dx_rework:active_supplier_profile_name'));
 IF EXISTS(SELECT 1 FROM current_supplier_catalog c WHERE c.supplier_type=candidate->>'supplierType'
   AND normalize_supplier_name(c.supplier_name)=normalize_supplier_name(candidate->>'supplierName'))
 OR EXISTS(SELECT 1 FROM supplier_onboarding_requests r JOIN supplier_onboarding_request_versions v
   ON (v.request_id,v.version)=(r.request_id,r.current_version)
   WHERE r.status='pending_approval' AND r.request_id IS DISTINCT FROM excluded_request
   AND v.profile->>'supplierType'=candidate->>'supplierType'
   AND normalize_supplier_name(v.profile->>'supplierName')=normalize_supplier_name(candidate->>'supplierName')) THEN
  RAISE EXCEPTION 'supplier already exists or has a pending application' USING ERRCODE='23505';
 END IF;
END; $$;
CREATE FUNCTION guard_supplier_onboarding_version() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE req supplier_onboarding_requests%ROWTYPE; prior integer; field text;
BEGIN
 PERFORM supplier_onboarding_authorized_roles(NEW.submitted_by,'request');
 SELECT * INTO STRICT req FROM supplier_onboarding_requests WHERE request_id=NEW.request_id FOR UPDATE;
 SELECT COALESCE(max(version),0) INTO prior FROM supplier_onboarding_request_versions WHERE request_id=NEW.request_id;
 IF NEW.submitted_by<>req.applicant_id OR NEW.version<>prior+1 OR
   (prior>0 AND (req.status<>'returned' OR req.current_version<>prior)) THEN
  RAISE EXCEPTION 'only the applicant may append a returned application version' USING ERRCODE='55000';
 END IF;
 FOREACH field IN ARRAY ARRAY['supplierName','supplierType','contactPerson','contactPhone','address','payeeName','bankAccount','bankName'] LOOP
  IF jsonb_typeof(NEW.profile->field) IS DISTINCT FROM 'string' OR length(btrim(NEW.profile->>field))=0 THEN
   RAISE EXCEPTION 'supplier application requires complete fields' USING ERRCODE='23514';
  END IF;
 END LOOP;
 IF jsonb_typeof(NEW.profile->'supportedCrafts') IS DISTINCT FROM 'array' OR jsonb_array_length(NEW.profile->'supportedCrafts')=0 THEN
  RAISE EXCEPTION 'supplier application requires crafts' USING ERRCODE='23514';
 END IF;
 PERFORM assert_supplier_onboarding_identity(NEW.profile,NEW.request_id);
 RETURN NEW;
END; $$;
CREATE TRIGGER supplier_onboarding_version_guard BEFORE INSERT ON supplier_onboarding_request_versions
 FOR EACH ROW EXECUTE FUNCTION guard_supplier_onboarding_version();
CREATE FUNCTION guard_supplier_onboarding_decision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE req supplier_onboarding_requests%ROWTYPE;
BEGIN
 PERFORM supplier_onboarding_authorized_roles(NEW.reviewer_id,'approve');
 SELECT * INTO STRICT req FROM supplier_onboarding_requests WHERE request_id=NEW.request_id FOR UPDATE;
 IF req.status<>'pending_approval' OR req.current_version<>NEW.version THEN
  RAISE EXCEPTION 'application no longer pending at this version' USING ERRCODE='55000';
 END IF;
 IF NEW.decision='approved' AND NOT EXISTS(
  SELECT 1 FROM supplier_onboarding_request_versions p
  JOIN supplier_catalog_items i ON i.supplier_id=NEW.supplier_id
  JOIN supplier_catalog_versions v ON v.supplier_id=i.supplier_id AND v.version=1
  WHERE p.request_id=NEW.request_id AND p.version=NEW.version AND v.created_at=CURRENT_TIMESTAMP AND v.changed_by=NEW.reviewer_id
    AND i.supplier_type=p.profile->>'supplierType' AND v.supplier_name=p.profile->>'supplierName' AND v.active
    AND v.notes=COALESCE(p.profile->>'notes','')
    AND v.contact_person=p.profile->>'contactPerson' AND v.contact_phone=p.profile->>'contactPhone'
    AND v.address=p.profile->>'address' AND v.payee_name=p.profile->>'payeeName'
    AND v.bank_account=p.profile->>'bankAccount' AND v.bank_name=p.profile->>'bankName'
    AND v.contract_entity_name IS NOT DISTINCT FROM p.profile->>'contractEntityName'
    AND v.party_b_representative IS NOT DISTINCT FROM p.profile->>'partyBRepresentative'
    AND to_jsonb(v.supported_crafts)=p.profile->'supportedCrafts'
    AND v.daily_capacity IS NOT DISTINCT FROM (p.profile->>'dailyCapacity')::integer
 ) THEN RAISE EXCEPTION 'approval requires the exact snapshot as a new formal supplier' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER supplier_onboarding_decision_guard BEFORE INSERT ON supplier_onboarding_decisions
 FOR EACH ROW EXECUTE FUNCTION guard_supplier_onboarding_decision();
CREATE FUNCTION guard_supplier_onboarding_header() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  PERFORM supplier_onboarding_authorized_roles(NEW.applicant_id,'request');
  IF NEW.current_version<>1 OR NEW.status<>'pending_approval' OR NEW.supplier_id IS NOT NULL THEN
   RAISE EXCEPTION 'invalid initial supplier application' USING ERRCODE='55000';
  END IF;
 ELSE
  IF (NEW.request_id,NEW.applicant_id,NEW.applicant_name,NEW.created_at) IS DISTINCT FROM (OLD.request_id,OLD.applicant_id,OLD.applicant_name,OLD.created_at) THEN
   RAISE EXCEPTION 'supplier applicant identity is immutable' USING ERRCODE='55000';
  END IF;
  IF OLD.status='returned' AND NEW.status='pending_approval' AND NEW.current_version=OLD.current_version+1 AND NEW.supplier_id IS NULL THEN
   IF NOT EXISTS(SELECT 1 FROM supplier_onboarding_request_versions WHERE request_id=NEW.request_id AND version=NEW.current_version) THEN
    RAISE EXCEPTION 'resubmission requires a new immutable version' USING ERRCODE='55000';
   END IF;
  ELSIF OLD.status='pending_approval' AND NEW.current_version=OLD.current_version AND NEW.status IN ('approved','returned') THEN
   IF NOT EXISTS(SELECT 1 FROM supplier_onboarding_decisions d WHERE d.request_id=NEW.request_id AND d.version=NEW.current_version
     AND d.decision=NEW.status AND d.supplier_id IS NOT DISTINCT FROM NEW.supplier_id) THEN
    RAISE EXCEPTION 'supplier application transition requires its decision' USING ERRCODE='55000';
   END IF;
  ELSE RAISE EXCEPTION 'invalid supplier application transition' USING ERRCODE='55000'; END IF;
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER supplier_onboarding_header_guard BEFORE INSERT OR UPDATE ON supplier_onboarding_requests
 FOR EACH ROW EXECUTE FUNCTION guard_supplier_onboarding_header();
DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['supplier_onboarding_requests','supplier_onboarding_request_versions','supplier_onboarding_decisions'] LOOP
  EXECUTE format('CREATE TRIGGER %I BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation()',tab||'_no_delete',tab);
  EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION reject_operation_event_mutation()',tab||'_no_truncate',tab);
  IF tab<>'supplier_onboarding_requests' THEN
   EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation()',tab||'_no_update',tab);
  END IF;
 END LOOP;
END; $$;
ALTER TABLE rework_todos DROP CONSTRAINT rework_todos_route_descriptor_check;
ALTER TABLE rework_todos ADD CONSTRAINT rework_todos_route_descriptor_check CHECK(
 jsonb_typeof(route_descriptor)='object' AND route_descriptor ? 'routeName' AND route_descriptor ? 'entityId'
 AND route_descriptor->>'routeName' IN ('rework_detail','process_configuration','whole_order_review','responsibility_detail',
 'own_factory_approval','external_responsibility_detail','wage_period_detail','sourcing_detail','production_detail','sample_detail','pattern_room_order','supplier_onboarding')
 AND length(btrim(route_descriptor->>'entityId'))>0
);

CREATE FUNCTION require_supplier_onboarding_audit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM operation_events e WHERE e.entity_type='supplier_onboarding' AND e.entity_id=NEW.request_id::text
  AND (e.after_state->>'version')::integer=NEW.current_version AND e.after_state->>'status'=NEW.status
  AND e.created_at=CURRENT_TIMESTAMP AND e.action IN ('supplier_onboarding.submitted','supplier_onboarding.resubmitted','supplier_onboarding.approved','supplier_onboarding.returned')) THEN
  RAISE EXCEPTION 'supplier application transition requires same-transaction audit' USING ERRCODE='55000';
 END IF;
 RETURN NEW;
END; $$;
CREATE CONSTRAINT TRIGGER supplier_onboarding_audit AFTER INSERT OR UPDATE ON supplier_onboarding_requests
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_supplier_onboarding_audit();
