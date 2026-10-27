-- Parallel business evidence; original PDF/upload audits, 48h checks and cycles are unchanged.
CREATE FUNCTION sourcing_contract_return_clock_scope(target uuid)
RETURNS TABLE(native_order_id uuid, scenario_id uuid) LANGUAGE plpgsql STABLE ROWS 1 AS $$
DECLARE generation text; mother uuid;
BEGIN
 SELECT c.workflow_generation INTO STRICT generation FROM sourcing_cases c WHERE c.sourcing_case_id=target;
 SELECT l.production_order_id INTO mother FROM digital_production_child_links l WHERE l.module='sourcing' AND l.child_id=target;
 IF generation='digital_production_v1' AND mother IS NULL OR generation<>'digital_production_v1' AND mother IS NOT NULL
 THEN RAISE EXCEPTION 'Contract return requires the original native sourcing link' USING ERRCODE='55000'; END IF;
 RETURN QUERY SELECT mother,r.scenario_id FROM (SELECT 1) one_row
 LEFT JOIN acceptance_sla_clock_resources r ON r.resource_kind='order' AND r.resource_id=mother;
END;
$$;

-- A historical revision is usable only when its exact instant is in the immutable scene ledger.
CREATE FUNCTION sourcing_contract_return_clock_evidence(scene_id uuid, evidence jsonb) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE revision bigint; at_time timestamptz; scene acceptance_sla_clock_scenarios%ROWTYPE;
BEGIN
 IF evidence IS NULL OR jsonb_typeof(evidence)<>'object'
  OR NOT(evidence ?& ARRAY['now','scenarioId','revision']) OR evidence-ARRAY['now','scenarioId','revision']<>'{}'::jsonb
  OR jsonb_typeof(evidence->'now') IS DISTINCT FROM 'string'
  OR evidence->>'scenarioId' IS DISTINCT FROM scene_id::text
  OR jsonb_typeof(evidence->'revision') IS DISTINCT FROM 'number'
  OR NOT COALESCE(evidence->>'revision' ~ '^[1-9][0-9]*$',false) THEN RETURN false; END IF;
 revision:=(evidence->>'revision')::bigint; at_time:=(evidence->>'now')::timestamptz;
 IF at_time IS NULL OR NOT isfinite(at_time) THEN RETURN false; END IF;
 SELECT * INTO STRICT scene FROM acceptance_sla_clock_scenarios s WHERE s.scenario_id=scene_id;
 RETURN revision<=scene.version AND at_time<=scene.business_now AND
  (revision=1 AND at_time=scene.initial_time OR EXISTS(SELECT 1 FROM acceptance_sla_clock_events e
    WHERE e.scenario_id=scene_id AND e.version=revision AND e.after_time=at_time));
EXCEPTION WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow OR numeric_value_out_of_range THEN
 RETURN false;
END;
$$;

CREATE FUNCTION sourcing_contract_return_assert_environment(scene_id uuid) RETURNS void LANGUAGE plpgsql STABLE AS $$
BEGIN
 IF current_database() !~* '(^|[_-])(accept(ance)?|uat|test)([_-]|$)' OR NOT EXISTS(
  SELECT 1 FROM acceptance_sla_clock_scenarios s JOIN owner_bootstrap_consumptions b ON b.corp_id=s.corporation_id
  JOIN identity_mappings i ON i.user_id=b.user_id AND i.provider='dingtalk' AND i.corp_id=b.corp_id AND i.provider_user_id=b.provider_user_id
  WHERE s.scenario_id=scene_id AND b.singleton AND b.provider_user_id='uat-root'
   AND EXISTS(SELECT 1 FROM user_role_assignments r WHERE r.user_id=b.user_id AND r.role_code='owner_group' AND r.revoked_at IS NULL))
 THEN RAISE EXCEPTION 'Contract return business clock requires the actual Acceptance Root corporation' USING ERRCODE='55000'; END IF;
END;
$$;

CREATE TABLE sourcing_contract_return_business_facts (
 submission_id uuid PRIMARY KEY REFERENCES sourcing_contract_return_submissions(submission_id),
 sourcing_case_id uuid NOT NULL REFERENCES sourcing_cases(sourcing_case_id),
 business_returned_at timestamptz NOT NULL CHECK(isfinite(business_returned_at)),
 business_time jsonb NOT NULL CHECK(jsonb_typeof(business_time)='object'),
 operation_event_id uuid NOT NULL UNIQUE REFERENCES operation_events(event_id),
 recorded_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE FUNCTION guard_sourcing_contract_return_business_fact() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE scope record; scene acceptance_sla_clock_scenarios%ROWTYPE; submission sourcing_contract_return_submissions%ROWTYPE;
 audit operation_events%ROWTYPE; submission_xid text; audit_xid text; files uuid[];
BEGIN
 SELECT * INTO STRICT scope FROM sourcing_contract_return_clock_scope(NEW.sourcing_case_id);
 IF scope.scenario_id IS NULL THEN RAISE EXCEPTION 'Ordinary contract returns retain their original audit lifecycle' USING ERRCODE='55000'; END IF;
 PERFORM sourcing_contract_return_assert_environment(scope.scenario_id);
 SELECT * INTO STRICT scene FROM acceptance_sla_clock_scenarios s WHERE s.scenario_id=scope.scenario_id FOR SHARE;
 SELECT * INTO submission FROM sourcing_contract_return_submissions s WHERE s.submission_id=NEW.submission_id;
 SELECT xmin::text INTO submission_xid FROM sourcing_contract_return_submissions s WHERE s.submission_id=NEW.submission_id;
 SELECT * INTO audit FROM operation_events e WHERE e.event_id=NEW.operation_event_id;
 SELECT xmin::text INTO audit_xid FROM operation_events e WHERE e.event_id=NEW.operation_event_id;
 SELECT array_agg(a.attachment_id ORDER BY a.position) INTO files FROM sourcing_contract_return_attachments a
  JOIN attachments f ON f.attachment_id=a.attachment_id WHERE a.submission_id=NEW.submission_id
   AND f.status='ready' AND f.entity_type='sourcing_contract_return' AND f.entity_id=NEW.sourcing_case_id::text
   AND f.uploaded_by=submission.submitted_by;
 IF submission.submission_id IS NULL OR submission.sourcing_case_id IS DISTINCT FROM NEW.sourcing_case_id
  OR submission_xid IS DISTINCT FROM (txid_current()%4294967296)::text OR audit_xid IS DISTINCT FROM (txid_current()%4294967296)::text
  OR audit.action IS DISTINCT FROM 'sourcing.contract_return.upload' OR audit.entity_type IS DISTINCT FROM 'sourcing_case'
  OR audit.entity_id IS DISTINCT FROM NEW.sourcing_case_id::text OR audit.actor_id IS DISTINCT FROM submission.submitted_by
  OR audit.after_state->>'submissionId' IS DISTINCT FROM NEW.submission_id::text
  OR audit.after_state->>'revision' IS DISTINCT FROM submission.revision::text
  OR audit.after_state->>'sourcingContractDocumentId' IS DISTINCT FROM submission.sourcing_contract_document_id::text
  OR cardinality(files) IS NULL OR cardinality(files) NOT BETWEEN 1 AND 2
  OR (SELECT count(*) FROM sourcing_contract_return_attachments a WHERE a.submission_id=NEW.submission_id)<>cardinality(files)
  OR audit.after_state->'attachmentIds' IS DISTINCT FROM to_jsonb(files)
  OR audit.after_state->'businessTime' IS DISTINCT FROM NEW.business_time
  OR NOT sourcing_contract_return_clock_evidence(scope.scenario_id,NEW.business_time)
  OR NEW.business_time->>'revision' IS DISTINCT FROM scene.version::text
  OR NEW.business_returned_at IS DISTINCT FROM scene.business_now
  OR (NEW.business_time->>'now')::timestamptz IS DISTINCT FROM NEW.business_returned_at
  OR NOT EXISTS(SELECT 1 FROM identity_mappings i JOIN app_users u ON u.id=i.user_id
    WHERE i.user_id=audit.actor_id AND u.enabled AND NOT u.manual_access_disabled AND i.provider='dingtalk'
     AND i.corp_id=scene.corporation_id AND i.provider_user_id LIKE 'uat-%' AND i.union_id LIKE 'uat-union-%' AND i.active AND i.employed)
 THEN RAISE EXCEPTION 'Contract return business evidence requires this UAT submission, files, current event and original clock' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER sourcing_contract_return_business_fact_guard BEFORE INSERT ON sourcing_contract_return_business_facts
 FOR EACH ROW EXECUTE FUNCTION guard_sourcing_contract_return_business_fact();
CREATE TRIGGER sourcing_contract_return_business_fact_immutable BEFORE UPDATE OR DELETE ON sourcing_contract_return_business_facts
 FOR EACH ROW EXECUTE FUNCTION guard_production_order_root_immutable();

-- Preserve the original function and its nine-column legacy/history contract.
-- This projection writes no old clock, PDF, return, attachment or cycle rows.
CREATE FUNCTION sourcing_contract_return_business_state(target uuid)
RETURNS TABLE(sourcing_case_id uuid,contract_return_monitor_enabled boolean,contract_return_catchup boolean,
 contract_generated_at timestamptz,contract_return_due_at timestamptz,contract_returned_at timestamptz,
 contract_return_uploaded_by uuid,contract_return_latest_uploaded_by uuid,return_cycle_id uuid,
 clock_order_id uuid,clock_scenario_id uuid,business_as_of timestamptz,time_quality text,time_reason text,has_valid_return boolean)
LANGUAGE plpgsql STABLE ROWS 1 AS $$
DECLARE legacy record; scope record; scene acceptance_sla_clock_scenarios%ROWTYPE;
 ready record; signed record; returned record; evidence jsonb; count_events bigint; matched_event_id uuid; needs_start boolean;
BEGIN
 SELECT * INTO STRICT legacy FROM sourcing_contract_return_facts(target);
 SELECT * INTO STRICT scope FROM sourcing_contract_return_clock_scope(target);
 sourcing_case_id:=legacy.sourcing_case_id;contract_return_monitor_enabled:=legacy.contract_return_monitor_enabled;
 contract_return_catchup:=legacy.contract_return_catchup;contract_generated_at:=legacy.contract_generated_at;
 contract_return_due_at:=legacy.contract_return_due_at;contract_returned_at:=legacy.contract_returned_at;
 contract_return_uploaded_by:=legacy.contract_return_uploaded_by;contract_return_latest_uploaded_by:=legacy.contract_return_latest_uploaded_by;
 return_cycle_id:=legacy.return_cycle_id;clock_order_id:=scope.native_order_id;clock_scenario_id:=scope.scenario_id;
 business_as_of:=CURRENT_TIMESTAMP;time_quality:='legacy_audit';time_reason:=NULL;has_valid_return:=legacy.contract_returned_at IS NOT NULL;
 IF scope.scenario_id IS NULL THEN RETURN NEXT;RETURN; END IF;
 PERFORM sourcing_contract_return_assert_environment(scope.scenario_id);
 SELECT * INTO STRICT scene FROM acceptance_sla_clock_scenarios s WHERE s.scenario_id=scope.scenario_id;
 business_as_of:=scene.business_now;time_quality:='business_projection';
 IF NOT contract_return_monitor_enabled THEN time_quality:='not_applicable';RETURN NEXT;RETURN; END IF;
 IF return_cycle_id IS NOT NULL THEN
  SELECT f.business_ready_at,f.business_time INTO ready FROM sourcing_contract_return_cycles c
   JOIN sourcing_contract_business_ready_facts f ON f.sourcing_contract_document_id=c.first_document_id
   JOIN sourcing_contract_documents d ON d.sourcing_contract_document_id=c.first_document_id
   WHERE c.sourcing_approval_snapshot_id=return_cycle_id AND f.sourcing_case_id=target
    AND c.generated_at=d.generated_at AND d.sourcing_approval_snapshot_id=c.sourcing_approval_snapshot_id;
 ELSE
  SELECT f.business_ready_at,f.business_time INTO ready FROM sourcing_contract_business_ready_facts f
   JOIN sourcing_contract_documents d USING(sourcing_contract_document_id)
   WHERE f.sourcing_case_id=target AND f.is_first_for_case AND d.generated_at=legacy.contract_generated_at;
 END IF;
 needs_start:=legacy.contract_generated_at IS NOT NULL;
 contract_generated_at:=NULL;contract_return_due_at:=NULL;contract_returned_at:=NULL;has_valid_return:=false;
 IF ready.business_time IS NOT NULL THEN
  IF ready.business_time->>'scenarioId' IS DISTINCT FROM scope.scenario_id::text
   THEN RAISE EXCEPTION 'Contract ready evidence belongs to another scene' USING ERRCODE='55000'; END IF;
  IF sourcing_contract_return_clock_evidence(scope.scenario_id,ready.business_time)
   AND (ready.business_time->>'now')::timestamptz=ready.business_ready_at THEN
   contract_generated_at:=ready.business_ready_at;
   contract_return_due_at:=sourcing_contract_return_add_hours(ready.business_ready_at,48);
  ELSE time_quality:='unknown';time_reason:='原合同业务起点缺少可信场景版本证据'; END IF;
 ELSIF needs_start THEN time_quality:='unknown';time_reason:='旧场景合同缺少原业务就绪时间，无法判定回签时效'; END IF;

 SELECT s.* INTO signed FROM sourcing_contract_return_submissions s
 LEFT JOIN sourcing_contract_documents d ON d.sourcing_contract_document_id=s.sourcing_contract_document_id
 WHERE s.sourcing_case_id=target AND (return_cycle_id IS NULL OR d.sourcing_approval_snapshot_id=return_cycle_id)
  AND EXISTS(SELECT 1 FROM sourcing_contract_return_attachments a JOIN attachments f USING(attachment_id)
    WHERE a.submission_id=s.submission_id AND f.status='ready')
 ORDER BY s.revision LIMIT 1;
 IF signed.submission_id IS NOT NULL THEN
  has_valid_return:=true;contract_return_uploaded_by:=signed.submitted_by;
  SELECT f.business_returned_at,f.business_time INTO returned FROM sourcing_contract_return_business_facts f WHERE f.submission_id=signed.submission_id;
  IF returned.business_time IS NOT NULL THEN
   IF returned.business_time->>'scenarioId' IS DISTINCT FROM scope.scenario_id::text
    THEN RAISE EXCEPTION 'Contract return evidence belongs to another scene' USING ERRCODE='55000'; END IF;
   evidence:=returned.business_time;
  ELSE
   -- Older events are usable only for this same submission, files, immutable UAT identity and clock revision.
   SELECT count(*),min(e.event_id::text)::uuid INTO count_events,matched_event_id FROM operation_events e
    WHERE e.action='sourcing.contract_return.upload' AND e.entity_type='sourcing_case' AND e.entity_id=target::text
     AND e.actor_id=signed.submitted_by AND e.after_state->>'submissionId'=signed.submission_id::text
     AND e.after_state->>'revision'=signed.revision::text
     AND e.after_state->>'sourcingContractDocumentId' IS NOT DISTINCT FROM signed.sourcing_contract_document_id::text
     AND e.after_state->'attachmentIds'=to_jsonb(ARRAY(SELECT a.attachment_id FROM sourcing_contract_return_attachments a WHERE a.submission_id=signed.submission_id ORDER BY a.position))
     AND sourcing_contract_return_clock_evidence(scope.scenario_id,COALESCE(e.after_state->'businessTime',e.after_state->'acceptanceClock'))
     AND EXISTS(SELECT 1 FROM identity_mappings i WHERE i.user_id=e.actor_id AND i.provider='dingtalk'
       AND i.corp_id=scene.corporation_id AND i.provider_user_id LIKE 'uat-%' AND i.union_id LIKE 'uat-union-%');
   IF count_events=1 THEN SELECT COALESCE(e.after_state->'businessTime',e.after_state->'acceptanceClock') INTO evidence FROM operation_events e WHERE e.event_id=matched_event_id; END IF;
  END IF;
  IF sourcing_contract_return_clock_evidence(scope.scenario_id,evidence) THEN contract_returned_at:=(evidence->>'now')::timestamptz;
  ELSE time_quality:='unknown';time_reason:=concat_ws('；',time_reason,'原有效回传缺少匹配的业务时间证据'); END IF;
 ELSIF legacy.contract_returned_at IS NOT NULL THEN
  time_quality:='unknown';time_reason:=concat_ws('；',time_reason,'原回传时间缺少同版本有效文件依据');
 END IF;
 RETURN NEXT;
END;
$$;
