-- Approved development rules. No historical source/task is enrolled or marked complete.
CREATE TABLE digital_development_cycle_standards (
 version integer PRIMARY KEY CHECK(version>0), values_json jsonb NOT NULL CHECK(jsonb_typeof(values_json)='object'),
 changed_by uuid REFERENCES app_users(id), reason text NOT NULL CHECK(length(btrim(reason))>0),
 recorded_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO digital_development_cycle_standards(version,values_json,reason)
 VALUES(1,'{"normalDays":7,"urgentDays":5,"sizeReviewHours":24,"externalWashDays":3}','2026-10-31 approved development defaults; new sources only');
CREATE TABLE digital_development_technical_enrollments (
 source_id uuid PRIMARY KEY REFERENCES digital_production_sources(source_id),
 rule_version text NOT NULL CHECK(rule_version='development-20261031.1'),
 policy_version integer NOT NULL REFERENCES digital_development_cycle_standards(version),
 values_json jsonb NOT NULL CHECK(jsonb_typeof(values_json)='object'),
 created_by uuid NOT NULL REFERENCES app_users(id), event_key text NOT NULL UNIQUE,
 recorded_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE digital_development_cycle_rounds (
 source_id uuid NOT NULL REFERENCES digital_development_technical_enrollments(source_id),
 round_number integer NOT NULL CHECK(round_number>0), published_at timestamptz NOT NULL,
 policy_version integer NOT NULL REFERENCES digital_development_cycle_standards(version),
 values_json jsonb NOT NULL CHECK(jsonb_typeof(values_json)='object'),
 internal_wash_minutes numeric NOT NULL CHECK(internal_wash_minutes>0),
 warning_ratio numeric NOT NULL CHECK(warning_ratio>0 AND warning_ratio<1),
 created_by uuid NOT NULL REFERENCES app_users(id), recorded_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(source_id,round_number)
);
CREATE TABLE digital_development_urgent_events (
 source_id uuid NOT NULL,round_number integer NOT NULL,revision integer NOT NULL CHECK(revision>0),
 action text NOT NULL CHECK(action IN ('request','approve','reject')),reason text NOT NULL CHECK(length(btrim(reason))>0),
 actor_id uuid NOT NULL REFERENCES app_users(id), occurred_at timestamptz NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,PRIMARY KEY(source_id,round_number,revision),
 FOREIGN KEY(source_id,round_number) REFERENCES digital_development_cycle_rounds(source_id,round_number)
);
CREATE TABLE digital_development_artifact_heads (
 artifact_set_id uuid PRIMARY KEY,source_id uuid NOT NULL REFERENCES digital_production_sources(source_id),
 round_number integer NOT NULL CHECK(round_number>0),scope_ref text NOT NULL CHECK(length(btrim(scope_ref)) BETWEEN 1 AND 100),
 current_version integer NOT NULL CHECK(current_version>0),published_version integer CHECK(published_version>0 AND published_version<=current_version),
 UNIQUE(source_id,round_number,scope_ref),UNIQUE(artifact_set_id,source_id,round_number,scope_ref)
);
CREATE TABLE digital_development_artifact_versions (
 artifact_set_id uuid NOT NULL REFERENCES digital_development_artifact_heads(artifact_set_id),version integer NOT NULL CHECK(version>0),
 source_id uuid NOT NULL,round_number integer NOT NULL,scope_ref text NOT NULL,
 task_id uuid NOT NULL REFERENCES digital_production_tasks(task_id),status text NOT NULL CHECK(status IN ('draft','published')),
 document_version integer NOT NULL CHECK(document_version>0),document_fingerprint char(64) NOT NULL,
 body jsonb NOT NULL CHECK(jsonb_typeof(body)='object'),created_by uuid NOT NULL REFERENCES app_users(id),
 created_at timestamptz NOT NULL,recorded_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(artifact_set_id,version),FOREIGN KEY(artifact_set_id,source_id,round_number,scope_ref)
 REFERENCES digital_development_artifact_heads(artifact_set_id,source_id,round_number,scope_ref)
);
CREATE TABLE digital_development_artifact_inheritances (
 source_id uuid NOT NULL REFERENCES digital_production_sources(source_id),round_number integer NOT NULL CHECK(round_number>0),scope_ref text NOT NULL,
 artifact_set_id uuid NOT NULL,artifact_version integer NOT NULL,created_by uuid NOT NULL REFERENCES app_users(id),created_at timestamptz NOT NULL,
 adopted_document_fingerprint char(64) NOT NULL CHECK(adopted_document_fingerprint ~ '^[0-9a-f]{64}$'),
 PRIMARY KEY(source_id,round_number,scope_ref),FOREIGN KEY(artifact_set_id,artifact_version) REFERENCES digital_development_artifact_versions(artifact_set_id,version)
);
ALTER TABLE digital_development_artifact_heads ADD CONSTRAINT development_artifact_current_version
 FOREIGN KEY(artifact_set_id,current_version) REFERENCES digital_development_artifact_versions(artifact_set_id,version) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE digital_development_artifact_heads ADD CONSTRAINT development_artifact_published_version
 FOREIGN KEY(artifact_set_id,published_version) REFERENCES digital_development_artifact_versions(artifact_set_id,version) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE digital_development_final_comments (
 comment_id uuid PRIMARY KEY,source_id uuid NOT NULL REFERENCES digital_production_sources(source_id),
 round_number integer NOT NULL CHECK(round_number>0),scope_ref text NOT NULL CHECK(length(btrim(scope_ref)) BETWEEN 1 AND 100),
 version integer NOT NULL CHECK(version>0),is_final boolean NOT NULL,decision text NOT NULL CHECK(decision IN ('approved','changes_required')),
 customer_code text,text_value text NOT NULL CHECK(length(btrim(text_value))>0),evidence_refs uuid[] NOT NULL,
 evidence_note text NOT NULL CHECK(length(btrim(evidence_note))>0),occurred_at timestamptz,recorded_at timestamptz NOT NULL,
 recorded_by uuid NOT NULL REFERENCES app_users(id),
 UNIQUE(source_id,round_number,scope_ref,version),UNIQUE(comment_id,source_id,round_number,scope_ref,version)
);
CREATE TABLE digital_development_size_review_requests (
 review_id uuid PRIMARY KEY,task_id uuid NOT NULL UNIQUE REFERENCES digital_production_tasks(task_id),
 source_id uuid NOT NULL,round_number integer NOT NULL,scope_ref text NOT NULL,
 final_comment_id uuid NOT NULL UNIQUE,final_comment_version integer NOT NULL,
 requested_artifact_set_id uuid,requested_artifact_version integer,requested_at timestamptz NOT NULL,
 FOREIGN KEY(final_comment_id,source_id,round_number,scope_ref,final_comment_version)
 REFERENCES digital_development_final_comments(comment_id,source_id,round_number,scope_ref,version),
 FOREIGN KEY(requested_artifact_set_id,requested_artifact_version) REFERENCES digital_development_artifact_versions(artifact_set_id,version),
 CHECK((requested_artifact_set_id IS NULL)=(requested_artifact_version IS NULL))
);
CREATE TABLE digital_development_size_review_results (
 review_id uuid PRIMARY KEY REFERENCES digital_development_size_review_requests(review_id),
 version integer NOT NULL DEFAULT 2 CHECK(version=2),decision text NOT NULL CHECK(decision IN ('reuse','revise')),
 artifact_set_id uuid NOT NULL,artifact_version integer NOT NULL,
 note text NOT NULL CHECK(length(btrim(note))>0),reviewed_by uuid NOT NULL REFERENCES app_users(id),reviewed_at timestamptz NOT NULL,
 FOREIGN KEY(artifact_set_id,artifact_version) REFERENCES digital_development_artifact_versions(artifact_set_id,version)
);
CREATE TABLE digital_development_technical_templates (
 template_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),customer_code text NOT NULL,
 body jsonb NOT NULL CHECK(jsonb_typeof(body)='object'),reason text NOT NULL CHECK(length(btrim(reason))>0),
 created_by uuid NOT NULL REFERENCES app_users(id),created_at timestamptz NOT NULL,PRIMARY KEY(template_id,version)
);
CREATE TABLE digital_development_technical_material_decisions (
 source_id uuid NOT NULL REFERENCES digital_production_sources(source_id),round_number integer NOT NULL CHECK(round_number>0),
 material_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),high_temperature_required boolean,
 basis text NOT NULL CHECK(length(btrim(basis))>0),supplier_evidence_ids uuid[] NOT NULL,
 warp_shrink_percent numeric(18,6) CHECK(warp_shrink_percent BETWEEN 0 AND 100),
 weft_shrink_percent numeric(18,6) CHECK(weft_shrink_percent BETWEEN 0 AND 100),
 created_by uuid NOT NULL REFERENCES app_users(id),created_at timestamptz NOT NULL,
 PRIMARY KEY(source_id,round_number,material_id,version)
);
CREATE TABLE digital_development_external_intervals (
 interval_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),source_id uuid NOT NULL REFERENCES digital_production_sources(source_id),
 round_number integer NOT NULL CHECK(round_number>0),kind text NOT NULL CHECK(kind IN ('工艺','外洗','外部纸样')),
 source_task_id uuid REFERENCES digital_production_tasks(task_id),external_pattern_request_id uuid,
 departed_at timestamptz,returned_at timestamptz,time_quality text NOT NULL CHECK(time_quality IN ('现场登记','补报未核实','已核实','缺失')),
 evidence_note text NOT NULL DEFAULT '' CHECK(length(evidence_note)<=2000),actor_id uuid NOT NULL REFERENCES app_users(id),recorded_at timestamptz NOT NULL,
 PRIMARY KEY(interval_id,version),CHECK(returned_at IS NULL OR departed_at IS NOT NULL AND returned_at>=departed_at)
);
CREATE TABLE digital_development_patch_issues (
 issue_id uuid PRIMARY KEY,source_id uuid NOT NULL REFERENCES digital_production_sources(source_id),
 round_number integer NOT NULL CHECK(round_number>0),tail_task_id uuid NOT NULL UNIQUE REFERENCES digital_production_tasks(task_id),
 payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),created_by uuid NOT NULL REFERENCES app_users(id),created_at timestamptz NOT NULL
);
CREATE TABLE digital_development_patch_decisions (
 issue_id uuid PRIMARY KEY REFERENCES digital_development_patch_issues(issue_id),version integer NOT NULL DEFAULT 2 CHECK(version=2),
 decision text NOT NULL CHECK(decision IN ('patch','new_round')),reusable_artifacts boolean NOT NULL,
 reason text NOT NULL CHECK(length(btrim(reason))>0),decided_by uuid NOT NULL REFERENCES app_users(id),decided_at timestamptz NOT NULL,
 CHECK(decision<>'patch' OR reusable_artifacts)
);
CREATE TABLE digital_development_patch_native_rounds (
 issue_id uuid PRIMARY KEY REFERENCES digital_development_patch_decisions(issue_id),
 native_round_id uuid NOT NULL UNIQUE REFERENCES pattern_room_rounds(round_id)
);
CREATE TABLE digital_development_patch_tasks (
 issue_id uuid NOT NULL REFERENCES digital_development_patch_issues(issue_id),purpose text NOT NULL CHECK(purpose IN ('work','tail','confirmation')),
 task_id uuid NOT NULL UNIQUE REFERENCES digital_production_tasks(task_id),PRIMARY KEY(issue_id,purpose)
);
CREATE TABLE digital_development_preparation_basis (
 source_id uuid NOT NULL REFERENCES digital_production_sources(source_id),round_number integer NOT NULL CHECK(round_number>0),version integer NOT NULL CHECK(version>0),
 basis text NOT NULL CHECK(basis IN ('first_development','confirmed_repeat')),final_fabric boolean NOT NULL,final_craft boolean NOT NULL,
 sample_evidence_ids uuid[] NOT NULL,customer_fabric_evidence_ids uuid[] NOT NULL,note text NOT NULL,
 created_by uuid NOT NULL REFERENCES app_users(id),created_at timestamptz NOT NULL,PRIMARY KEY(source_id,round_number,version)
);

DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['digital_development_cycle_standards','digital_development_technical_enrollments','digital_development_cycle_rounds',
  'digital_development_urgent_events','digital_development_artifact_versions','digital_development_artifact_inheritances','digital_development_final_comments','digital_development_size_review_requests',
  'digital_development_size_review_results','digital_development_technical_templates','digital_development_technical_material_decisions',
  'digital_development_external_intervals','digital_development_patch_issues','digital_development_patch_decisions','digital_development_patch_native_rounds',
  'digital_development_patch_tasks','digital_development_preparation_basis'] LOOP
  EXECUTE format('CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION guard_production_order_root_immutable()',t);
 END LOOP;
END $$;
CREATE FUNCTION guard_development_artifact_head_identity() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' OR ROW(NEW.artifact_set_id,NEW.source_id,NEW.round_number,NEW.scope_ref) IS DISTINCT FROM ROW(OLD.artifact_set_id,OLD.source_id,OLD.round_number,OLD.scope_ref)
  OR NEW.current_version<>OLD.current_version+1 THEN RAISE EXCEPTION 'artifact identity/history cannot be rewritten' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER development_artifact_head_identity BEFORE UPDATE OR DELETE ON digital_development_artifact_heads
 FOR EACH ROW EXECUTE FUNCTION guard_development_artifact_head_identity();

CREATE FUNCTION guard_development_technical_scope() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r record; a record; BEGIN
 IF TG_TABLE_NAME='digital_development_artifact_versions' THEN
  IF NOT EXISTS(SELECT 1 FROM digital_production_tasks t JOIN digital_production_task_access p USING(task_id)
    WHERE t.task_id=NEW.task_id AND p.source_id=NEW.source_id AND t.route_version=NEW.round_number
      AND p.task_kind IN ('development_pattern','development_size_review')) THEN
   RAISE EXCEPTION 'artifact task scope mismatch' USING ERRCODE='23514'; END IF;
 ELSIF TG_TABLE_NAME='digital_development_size_review_requests' THEN
  IF NOT EXISTS(SELECT 1 FROM digital_development_final_comments c JOIN digital_production_task_access p ON p.task_id=NEW.task_id
    JOIN digital_production_tasks t ON t.task_id=p.task_id WHERE c.comment_id=NEW.final_comment_id AND c.is_final
      AND p.source_id=NEW.source_id AND t.route_version=NEW.round_number AND p.task_kind='development_size_review') THEN
   RAISE EXCEPTION 'review requires a final comment and its own task' USING ERRCODE='23514'; END IF;
 ELSIF TG_TABLE_NAME='digital_development_size_review_results' THEN
  SELECT * INTO r FROM digital_development_size_review_requests WHERE review_id=NEW.review_id;
  SELECT * INTO a FROM digital_development_artifact_versions WHERE artifact_set_id=NEW.artifact_set_id AND version=NEW.artifact_version;
  IF r IS NULL OR a IS NULL OR a.status<>'published' OR (ROW(r.source_id,r.round_number,r.scope_ref) IS DISTINCT FROM ROW(a.source_id,a.round_number,a.scope_ref) AND NOT EXISTS(
    SELECT 1 FROM digital_development_artifact_inheritances i WHERE i.source_id=r.source_id AND i.round_number=r.round_number AND i.scope_ref=r.scope_ref
     AND i.artifact_set_id=a.artifact_set_id AND i.artifact_version=a.version)) THEN
   RAISE EXCEPTION 'review artifact scope mismatch' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER development_artifact_scope BEFORE INSERT ON digital_development_artifact_versions FOR EACH ROW EXECUTE FUNCTION guard_development_technical_scope();
CREATE TRIGGER development_review_request_scope BEFORE INSERT ON digital_development_size_review_requests FOR EACH ROW EXECUTE FUNCTION guard_development_technical_scope();
CREATE TRIGGER development_review_result_scope BEFORE INSERT ON digital_development_size_review_results FOR EACH ROW EXECUTE FUNCTION guard_development_technical_scope();

ALTER TABLE attachments DROP CONSTRAINT attachments_mime_type_check,
 ADD CONSTRAINT attachments_mime_type_check CHECK(mime_type IN ('image/jpeg','image/png','image/webp','application/pdf','application/octet-stream'));
ALTER TABLE digital_development_upload_purposes DROP CONSTRAINT digital_development_upload_purposes_purpose_check,
 DROP CONSTRAINT digital_development_upload_task_check,
 ADD CONSTRAINT digital_development_upload_purposes_purpose_check CHECK(purpose IN ('工艺开发板','面料报告','车板成果','纸样成果','尾查照片','外部纸样','定位图','工艺回样照片','客户评语依据','补做成果')),
 ADD CONSTRAINT digital_development_upload_task_check CHECK((purpose IN ('车板成果','纸样成果','尾查照片','定位图','工艺回样照片','补做成果'))=(task_id IS NOT NULL));
INSERT INTO digital_production_deadline_policies(node_key,version,label,sla_seconds,warning_ratio) VALUES
 ('development_positioning',1,'设计定位图',NULL,0.7),('development_size_review',1,'最终评语尺寸复核',86400,0.7),
 ('development_patch',1,'原轮次局部补做',NULL,0.7),('development_patch_tail_check',1,'补做尾查',1800,0.7),
 ('development_patch_confirmation',1,'补做设计确认',NULL,0.7);
ALTER TABLE digital_development_route_facts DROP CONSTRAINT digital_development_route_facts_kind_check,
 ADD CONSTRAINT digital_development_route_facts_kind_check CHECK(kind IN ('发工艺','工艺完成','工艺确认','转交车板','车板完成','洗前检查','洗水送出','洗水完成','尾查通过','尾查退回','最终设计确认','寄出','客户样板确认','定位图确认','补做完成'));
