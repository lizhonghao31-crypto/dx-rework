-- PR-12: immutable wage facts, sequential review, adjustments and month-close snapshots.
DROP TRIGGER business_roles_no_insert ON business_roles;
DROP TRIGGER capability_catalog_no_insert ON capability_catalog;
DROP TRIGGER role_capabilities_no_insert ON role_capabilities;
INSERT INTO business_roles(role_code,display_name,description) VALUES
 ('administrative_clerk','行政文员','工资行政复核及调整审批'),
 ('wage_month_close_accountant','工资月结会计','工资月结锁定') ON CONFLICT DO NOTHING;
INSERT INTO capability_catalog(capability,display_name,description) VALUES
 ('wage:view','工资查看','查看工资期间和明细'),('wage:tail_review','工资初核','尾部工资初核'),
 ('wage:administrative_review','工资行政复核','行政工资复核'),('wage:month_close','工资月结','锁定工资月份'),
 ('wage:adjustment_request','工资调整发起','发起工资调整'),('wage:adjustment_approve','工资调整审批','审批工资调整'),
 ('wage:export','工资导出','导出工资工作簿') ON CONFLICT DO NOTHING;
INSERT INTO role_capabilities(role_code,capability) VALUES
 ('tail_supervisor','wage:view'),('tail_supervisor','wage:tail_review'),('tail_supervisor','wage:adjustment_request'),
 ('administrative_clerk','wage:view'),('administrative_clerk','wage:administrative_review'),('administrative_clerk','wage:adjustment_approve'),('administrative_clerk','wage:export'),
 ('wage_month_close_accountant','wage:view'),('wage_month_close_accountant','wage:month_close'),('wage_month_close_accountant','wage:export'),
 ('owner_group','wage:view'),('production_management','wage:view'),('system_admin','wage:view'),
 ('finance_read','wage:view'),('finance_read','wage:export') ON CONFLICT DO NOTHING;
CREATE TRIGGER business_roles_no_insert BEFORE INSERT ON business_roles FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER capability_catalog_no_insert BEFORE INSERT ON capability_catalog FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER role_capabilities_no_insert BEFORE INSERT ON role_capabilities FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();

CREATE TABLE rework_wage_periods (
 period_id uuid PRIMARY KEY, period_month date NOT NULL UNIQUE CHECK(period_month=date_trunc('month',period_month)::date),
 timezone text NOT NULL DEFAULT 'Asia/Singapore' CHECK(timezone='Asia/Singapore'), status text NOT NULL CHECK(status IN ('pending_tail_review','pending_admin_review','ready_to_lock','locked')),
 period_version integer NOT NULL DEFAULT 1 CHECK(period_version>0), source_item_count integer NOT NULL DEFAULT 0 CHECK(source_item_count>=0), person_count integer NOT NULL DEFAULT 0 CHECK(person_count>=0),
 original_total numeric(18,2) NOT NULL DEFAULT 0, adjustment_total numeric(18,2) NOT NULL DEFAULT 0, final_total numeric(18,2) NOT NULL DEFAULT 0,
 locked_by uuid REFERENCES app_users(id), locked_at timestamptz, lock_note text, created_operation_event_id uuid REFERENCES operation_events(event_id), created_request_id text NOT NULL,
 locked_operation_event_id uuid REFERENCES operation_events(event_id), locked_request_id text, created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK((status='locked')=(locked_by IS NOT NULL AND locked_at IS NOT NULL AND locked_operation_event_id IS NOT NULL AND locked_request_id IS NOT NULL)), CHECK(final_total=original_total+adjustment_total)
);
CREATE TABLE rework_wage_items (
 wage_item_id uuid PRIMARY KEY, period_id uuid NOT NULL REFERENCES rework_wage_periods(period_id), order_review_id uuid NOT NULL REFERENCES rework_order_reviews(order_review_id),
 rework_order_id uuid NOT NULL REFERENCES rework_orders(rework_order_id), configuration_item_id uuid NOT NULL REFERENCES rework_process_configuration_items(configuration_item_id), work_task_id uuid NOT NULL REFERENCES rework_work_tasks(work_task_id),
 work_report_id uuid NOT NULL REFERENCES rework_work_reports(work_report_id), person_id uuid NOT NULL REFERENCES business_people(person_id), person_name_snapshot text NOT NULL, person_type_snapshot text NOT NULL CHECK(person_type_snapshot IN ('internal','temporary')),
 rework_no_snapshot text NOT NULL, style_no_snapshot text NOT NULL, process_name_snapshot text NOT NULL, pricing_unit_snapshot text NOT NULL CHECK(pricing_unit_snapshot IN ('piece','hour')),
 unit_price_snapshot numeric(14,3) NOT NULL, actual_quantity_snapshot numeric(14,2) NOT NULL, assignment_mode text NOT NULL CHECK(assignment_mode IN ('individual','collective')),
 group_amount numeric(18,8) NOT NULL, exact_person_share numeric(18,8) NOT NULL, payable_amount numeric(18,2) NOT NULL, fractional_remainder numeric(18,8) NOT NULL,
 remainder_rank integer NOT NULL CHECK(remainder_rank>0), member_count integer NOT NULL CHECK(member_count>0), member_snapshot jsonb NOT NULL, source_report_snapshot jsonb NOT NULL,
 rounding_rule text NOT NULL DEFAULT 'largest_remainder_floor_cent_person_id', operation_event_id uuid REFERENCES operation_events(event_id), operation_request_id text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(work_report_id,person_id)
);
CREATE TABLE rework_wage_review_actions (
 review_action_id uuid PRIMARY KEY, period_id uuid NOT NULL REFERENCES rework_wage_periods(period_id), period_version_snapshot integer NOT NULL,
 stage text NOT NULL CHECK(stage IN ('tail','administrative')), decision text NOT NULL CHECK(decision IN ('approved','returned')),
 reason text, acted_by uuid NOT NULL REFERENCES app_users(id), actor_role_snapshot text NOT NULL, operation_event_id uuid NOT NULL REFERENCES operation_events(event_id), operation_request_id text NOT NULL, acted_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK((stage='tail' AND decision='approved' AND actor_role_snapshot='tail_supervisor' AND reason IS NULL) OR (stage='administrative' AND actor_role_snapshot='administrative_clerk' AND (decision='approved' OR (decision='returned' AND length(btrim(reason))>0))))
);
CREATE TABLE rework_wage_adjustments (
 adjustment_id uuid PRIMARY KEY, original_wage_item_id uuid NOT NULL REFERENCES rework_wage_items(wage_item_id), target_period_id uuid NOT NULL REFERENCES rework_wage_periods(period_id), person_id uuid NOT NULL REFERENCES business_people(person_id),
 adjustment_amount numeric(18,2) NOT NULL CHECK(adjustment_amount<>0), reason text NOT NULL CHECK(length(btrim(reason))>0), attachment_ids uuid[] NOT NULL DEFAULT '{}', status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
 requested_by uuid NOT NULL REFERENCES app_users(id), requested_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP, decided_by uuid REFERENCES app_users(id), decided_at timestamptz, decision_reason text,
 request_operation_event_id uuid NOT NULL REFERENCES operation_events(event_id), request_operation_request_id text NOT NULL, decision_operation_event_id uuid REFERENCES operation_events(event_id), decision_operation_request_id text,
 version integer NOT NULL DEFAULT 1 CHECK(version>0), CHECK(requested_by IS DISTINCT FROM decided_by), CHECK((status='pending')=(decided_by IS NULL AND decided_at IS NULL AND decision_operation_event_id IS NULL)), CHECK(status<>'rejected' OR length(btrim(decision_reason))>0)
);
CREATE TABLE rework_wage_month_closures (
 closure_id uuid PRIMARY KEY, period_id uuid NOT NULL UNIQUE REFERENCES rework_wage_periods(period_id), period_version_snapshot integer NOT NULL, item_count integer NOT NULL, person_count integer NOT NULL,
 original_total numeric(18,2) NOT NULL, adjustment_total numeric(18,2) NOT NULL, final_total numeric(18,2) NOT NULL, locked_by uuid NOT NULL REFERENCES app_users(id), locked_at timestamptz NOT NULL,
 lock_note text, operation_event_id uuid NOT NULL REFERENCES operation_events(event_id), operation_request_id text NOT NULL, CHECK(final_total=original_total+adjustment_total)
);
CREATE TABLE rework_wage_month_close_lines (
 closure_line_id uuid PRIMARY KEY, closure_id uuid NOT NULL REFERENCES rework_wage_month_closures(closure_id), line_type text NOT NULL CHECK(line_type IN ('wage_item','adjustment')),
 wage_item_id uuid REFERENCES rework_wage_items(wage_item_id), adjustment_id uuid REFERENCES rework_wage_adjustments(adjustment_id), person_id uuid NOT NULL REFERENCES business_people(person_id),
 person_name_snapshot text NOT NULL, person_type_snapshot text NOT NULL, rework_no_snapshot text NOT NULL, style_no_snapshot text NOT NULL, process_name_snapshot text NOT NULL,
 quantity_snapshot numeric(14,2) NOT NULL, unit_snapshot text NOT NULL, unit_price_snapshot numeric(14,3) NOT NULL, assignment_mode text NOT NULL, member_snapshot jsonb NOT NULL,
 original_amount numeric(18,2) NOT NULL, adjustment_amount numeric(18,2) NOT NULL, final_amount numeric(18,2) NOT NULL,
 CHECK(final_amount=original_amount+adjustment_amount), CHECK((line_type='wage_item' AND wage_item_id IS NOT NULL AND adjustment_id IS NULL) OR (line_type='adjustment' AND wage_item_id IS NULL AND adjustment_id IS NOT NULL))
);

CREATE FUNCTION reject_wage_immutable_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'wage history is immutable' USING ERRCODE='55000'; END $$;
CREATE TRIGGER wage_items_no_update BEFORE UPDATE ON rework_wage_items FOR EACH ROW EXECUTE FUNCTION reject_wage_immutable_mutation();
CREATE TRIGGER wage_items_no_delete BEFORE DELETE ON rework_wage_items FOR EACH ROW EXECUTE FUNCTION reject_wage_immutable_mutation(); CREATE TRIGGER wage_items_no_truncate BEFORE TRUNCATE ON rework_wage_items FOR EACH STATEMENT EXECUTE FUNCTION reject_wage_immutable_mutation();
CREATE TRIGGER wage_reviews_no_update BEFORE UPDATE ON rework_wage_review_actions FOR EACH ROW EXECUTE FUNCTION reject_wage_immutable_mutation(); CREATE TRIGGER wage_reviews_no_delete BEFORE DELETE ON rework_wage_review_actions FOR EACH ROW EXECUTE FUNCTION reject_wage_immutable_mutation(); CREATE TRIGGER wage_reviews_no_truncate BEFORE TRUNCATE ON rework_wage_review_actions FOR EACH STATEMENT EXECUTE FUNCTION reject_wage_immutable_mutation();
CREATE TRIGGER wage_closures_no_update BEFORE UPDATE ON rework_wage_month_closures FOR EACH ROW EXECUTE FUNCTION reject_wage_immutable_mutation(); CREATE TRIGGER wage_closures_no_delete BEFORE DELETE ON rework_wage_month_closures FOR EACH ROW EXECUTE FUNCTION reject_wage_immutable_mutation(); CREATE TRIGGER wage_closures_no_truncate BEFORE TRUNCATE ON rework_wage_month_closures FOR EACH STATEMENT EXECUTE FUNCTION reject_wage_immutable_mutation();
CREATE TRIGGER wage_lines_no_update BEFORE UPDATE ON rework_wage_month_close_lines FOR EACH ROW EXECUTE FUNCTION reject_wage_immutable_mutation(); CREATE TRIGGER wage_lines_no_delete BEFORE DELETE ON rework_wage_month_close_lines FOR EACH ROW EXECUTE FUNCTION reject_wage_immutable_mutation(); CREATE TRIGGER wage_lines_no_truncate BEFORE TRUNCATE ON rework_wage_month_close_lines FOR EACH STATEMENT EXECUTE FUNCTION reject_wage_immutable_mutation();
CREATE TRIGGER wage_adjustments_no_delete BEFORE DELETE ON rework_wage_adjustments FOR EACH ROW EXECUTE FUNCTION reject_wage_immutable_mutation(); CREATE TRIGGER wage_adjustments_no_truncate BEFORE TRUNCATE ON rework_wage_adjustments FOR EACH STATEMENT EXECUTE FUNCTION reject_wage_immutable_mutation();

CREATE FUNCTION materialize_rework_wages_from_order_review(p_order_review_id uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_review rework_order_reviews%ROWTYPE; v_period uuid; v_report record; v_sum numeric(18,2); v_inserted integer:=0; v_rows integer:=0;
BEGIN
 SELECT * INTO STRICT v_review FROM rework_order_reviews WHERE order_review_id=p_order_review_id;
 INSERT INTO rework_wage_periods(period_id,period_month,status,created_operation_event_id,created_request_id)
 VALUES(gen_random_uuid(),date_trunc('month',v_review.reviewed_at AT TIME ZONE 'Asia/Singapore')::date,'pending_tail_review',nullif(current_setting('dx_rework.whole_order_review_event_id',true),'')::uuid,coalesce(nullif(current_setting('dx_rework.whole_order_review_request_id',true),''),'database-trigger'))
 ON CONFLICT(period_month) DO NOTHING;
 SELECT period_id INTO v_period FROM rework_wage_periods WHERE period_month=date_trunc('month',v_review.reviewed_at AT TIME ZONE 'Asia/Singapore')::date FOR UPDATE;
 IF (SELECT status FROM rework_wage_periods WHERE period_id=v_period)='locked' THEN RAISE EXCEPTION 'cannot add wage source to locked period' USING ERRCODE='23514'; END IF;
 FOR v_report IN SELECT r.work_report_id FROM rework_work_reports r WHERE r.rework_order_id=v_review.rework_order_id AND r.status='submitted' AND NOT EXISTS(SELECT 1 FROM rework_work_report_rejections x WHERE x.work_report_id=r.work_report_id) LOOP
  WITH source AS (
   SELECT s.person_id,s.amount,tm.display_name_snapshot,tm.person_type_snapshot,row_number() OVER(ORDER BY (s.amount-trunc(s.amount,2)) DESC,s.person_id) rank,
    count(*) OVER() member_count,jsonb_agg(jsonb_build_object('personId',s.person_id,'displayName',tm.display_name_snapshot,'personType',tm.person_type_snapshot) ORDER BY s.person_id) OVER() members,
    round(r.group_amount,2)-sum(trunc(s.amount,2)) OVER() cents_left,r.*,t.assignment_mode,i.process_name,i.pricing_unit,i.unit_price,o.rework_no,o.style_no
   FROM rework_work_report_member_shares s JOIN rework_work_reports r USING(work_report_id) JOIN rework_work_tasks t USING(work_task_id)
   JOIN rework_work_task_members tm ON tm.work_task_id=t.work_task_id AND tm.person_id=s.person_id JOIN rework_process_configuration_items i USING(configuration_item_id) JOIN rework_orders o USING(rework_order_id)
   WHERE s.work_report_id=v_report.work_report_id
  )
  INSERT INTO rework_wage_items(wage_item_id,period_id,order_review_id,rework_order_id,configuration_item_id,work_task_id,work_report_id,person_id,person_name_snapshot,person_type_snapshot,rework_no_snapshot,style_no_snapshot,process_name_snapshot,pricing_unit_snapshot,unit_price_snapshot,actual_quantity_snapshot,assignment_mode,group_amount,exact_person_share,payable_amount,fractional_remainder,remainder_rank,member_count,member_snapshot,source_report_snapshot,operation_event_id,operation_request_id)
  SELECT gen_random_uuid(),v_period,p_order_review_id,rework_order_id,configuration_item_id,work_task_id,work_report_id,person_id,display_name_snapshot,person_type_snapshot,rework_no,style_no,process_name,pricing_unit,unit_price,actual_quantity,assignment_mode,group_amount,amount,
   trunc(amount,2)+CASE WHEN rank<=round(cents_left*100)::integer THEN .01 ELSE 0 END,amount-trunc(amount,2),rank,member_count,members,to_jsonb(source)-ARRAY['display_name_snapshot','person_type_snapshot','members'],nullif(current_setting('dx_rework.whole_order_review_event_id',true),'')::uuid,coalesce(nullif(current_setting('dx_rework.whole_order_review_request_id',true),''),'database-trigger') FROM source ON CONFLICT(work_report_id,person_id) DO NOTHING;
  GET DIAGNOSTICS v_rows=ROW_COUNT; v_inserted:=v_inserted+v_rows;
  SELECT sum(payable_amount) INTO v_sum FROM rework_wage_items WHERE work_report_id=v_report.work_report_id;
  IF v_sum<>(SELECT round(group_amount,2) FROM rework_work_reports WHERE work_report_id=v_report.work_report_id) THEN RAISE EXCEPTION 'wage allocation does not equal rounded group amount' USING ERRCODE='23514'; END IF;
 END LOOP;
 IF v_inserted>0 THEN UPDATE rework_wage_periods p SET source_item_count=(SELECT count(*) FROM rework_wage_items WHERE period_id=v_period),person_count=(SELECT count(DISTINCT person_id) FROM rework_wage_items WHERE period_id=v_period),original_total=(SELECT coalesce(sum(payable_amount),0) FROM rework_wage_items WHERE period_id=v_period),final_total=(SELECT coalesce(sum(payable_amount),0) FROM rework_wage_items WHERE period_id=v_period)+adjustment_total,period_version=period_version+1,status='pending_tail_review',updated_at=CURRENT_TIMESTAMP WHERE period_id=v_period; END IF;
END $$;
CREATE FUNCTION trigger_materialize_rework_wages() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM materialize_rework_wages_from_order_review(NEW.order_review_id); RETURN NEW; END $$;
CREATE TRIGGER rework_order_reviews_materialize_wages AFTER INSERT ON rework_order_reviews FOR EACH ROW EXECUTE FUNCTION trigger_materialize_rework_wages();
