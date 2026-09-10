-- Order-level revision reuses immutable determination versions and actual deduction facts.
CREATE FUNCTION external_deduction_scope(target_id uuid)
RETURNS SETOF rework_external_deduction_entries LANGUAGE sql STABLE AS $$
 SELECT entry.* FROM rework_external_responsibility_cases target
 JOIN rework_external_responsibility_batches target_batch ON target_batch.batch_id=target.batch_id
 JOIN rework_external_responsibility_cases source ON source.rework_order_id=target.rework_order_id
   AND source.responsibility_type=target.responsibility_type AND source.supplier_id=target.supplier_id
 JOIN rework_external_responsibility_batches source_batch ON source_batch.batch_id=source.batch_id
 JOIN rework_external_deduction_entries entry ON entry.case_id=source.case_id
 WHERE target.case_id=target_id AND (source.case_id=target_id
   OR source_batch.finalized_determination_version<target_batch.finalized_determination_version)
$$;

-- Preserve the current guard body, including fixes made after its original migration.
DO $$
DECLARE original text; revised text;
BEGIN
 SELECT pg_get_functiondef('guard_rework_order_write()'::regprocedure) INTO original;
 revised:=replace(original,
 $old$    ELSIF EXISTS(SELECT 1 FROM operation_events event WHERE event.event_id=audit_event_id::uuid AND event.request_id=audit_request_id AND event.action='rework.attachments.supplement'$old$,
 $new$    ELSIF EXISTS(SELECT 1 FROM operation_events event WHERE event.event_id=audit_event_id::uuid AND event.request_id=audit_request_id AND event.action='rework.responsibility.reopen') THEN
      IF OLD.status NOT IN ('completed','pending_responsibility_action') OR NEW.status<>'pending_responsibility_determination'
        OR NOT (access_is_root_actor(NEW.updated_by) OR external_responsibility_direct_role(NEW.updated_by,'external_responsibility:approve_revision',ARRAY['production_management','owner_group']))
        OR (to_jsonb(NEW)-ARRAY['status','version','updated_by','updated_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','version','updated_by','updated_at'])
      THEN RAISE EXCEPTION 'order responsibility revision requires an eligible completed order and authorized reviewer' USING ERRCODE='42501'; END IF;
      expected_action:='rework.responsibility.reopen'; expected_capability:='responsibility:determine';
    ELSIF EXISTS(SELECT 1 FROM operation_events event WHERE event.event_id=audit_event_id::uuid AND event.request_id=audit_request_id AND event.action='rework.attachments.supplement'$new$);
 IF revised=original THEN RAISE EXCEPTION '0170 order guard patch target missing'; END IF; EXECUTE revised;
 SELECT pg_get_functiondef('guard_determination_insert()'::regprocedure) INTO original;
 revised:=replace(original,
 $old$         AND NOT access_is_root_actor(event_actor)
       ) THEN$old$,
 $new$         AND NOT access_is_root_actor(event_actor)
         AND NOT (event_action='rework.responsibility.reopen' AND external_responsibility_direct_role(event_actor,'external_responsibility:approve_revision',ARRAY['production_management','owner_group']))
       ) THEN$new$);
 IF revised=original THEN RAISE EXCEPTION '0170 determination guard patch target missing'; END IF; EXECUTE revised;
END $$;

CREATE OR REPLACE FUNCTION external_responsibility_superseded_by_finalization(previous_determination_id uuid, order_id uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS (
  SELECT 1 FROM operation_events e JOIN rework_responsibility_determinations successor
    ON successor.rework_order_id=order_id AND successor.replaces_determination_id=previous_determination_id
  WHERE e.event_id=nullif(current_setting('dx_rework.rework_event_id',true),'')::uuid
    AND e.request_id=nullif(current_setting('dx_rework.rework_request_id',true),'')
    AND e.authorization_capability='responsibility:determine' AND e.entity_type='rework_order' AND e.entity_id=order_id::text
    AND ((e.action='rework.responsibility.finalize' AND successor.stage='finalized')
      OR (e.action='rework.responsibility.reopen' AND successor.stage='draft' AND successor.operation_event_id=e.event_id
        AND (access_is_root_actor(e.actor_id) OR external_responsibility_direct_role(e.actor_id,'external_responsibility:approve_revision',ARRAY['production_management','owner_group']))))
 )
$$;

-- Existing entry and closure guards use the same historical-paid scope as the UI.
DO $$
DECLARE name text; original text; revised text;
BEGIN
 FOREACH name IN ARRAY ARRAY['guard_external_deduction_entry_insert','guard_external_closure_insert','guard_external_special_request_insert'] LOOP
  SELECT pg_get_functiondef((name||'()')::regprocedure) INTO original;
  revised:=regexp_replace(original,'FROM rework_external_deduction_entries[[:space:]]+WHERE case_id=NEW.case_id','FROM external_deduction_scope(NEW.case_id)','g');
  IF revised=original THEN RAISE EXCEPTION '0170 deduction guard patch target missing: %',name; END IF;
  EXECUTE revised;
 END LOOP;
END $$;

CREATE FUNCTION guard_responsibility_revision_paid_floor() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.stage='finalized' AND EXISTS (
  SELECT 1 FROM rework_external_deduction_entries entry
  JOIN rework_external_responsibility_cases c USING(case_id)
  WHERE c.rework_order_id=NEW.rework_order_id
  GROUP BY c.responsibility_type,c.supplier_id
  HAVING sum(entry.amount)>COALESCE((SELECT sum(a.rounded_amount) FROM rework_responsibility_allocations a
    WHERE a.determination_id=NEW.determination_id AND a.responsibility_type=c.responsibility_type AND a.supplier_id=c.supplier_id),0)
 ) THEN RAISE EXCEPTION '新责任不能低于该责任方已扣金额；退款、抵账、冲销不在本轮范围' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER responsibility_revision_paid_floor AFTER INSERT ON rework_responsibility_determinations
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION guard_responsibility_revision_paid_floor();
