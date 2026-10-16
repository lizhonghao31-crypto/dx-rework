-- A revision approver authorizes reopening; it does not transfer the N08 handler.
-- Permit only the seed tied to the same trusted approval/request/source version.
CREATE FUNCTION external_revision_can_seed_draft(
  reviewer uuid, order_id uuid, predecessor_id uuid
) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT external_responsibility_direct_role(
   reviewer,'external_responsibility:approve_revision',ARRAY['production_management','owner_group']
 ) AND EXISTS (
   SELECT 1 FROM operation_events event
   JOIN rework_external_responsibility_revision_requests revision
     ON revision.finalized_determination_id=predecessor_id
   JOIN rework_external_responsibility_cases target ON target.case_id=revision.case_id
   JOIN rework_responsibility_determinations predecessor
     ON predecessor.determination_id=revision.finalized_determination_id
   WHERE event.event_id=nullif(current_setting('dx_rework.external_responsibility_event_id',true),'')::uuid
     AND event.request_id=nullif(current_setting('dx_rework.external_responsibility_request_id',true),'')
     AND event.request_id=nullif(current_setting('dx_rework.responsibility_request_id',true),'')
     AND event.actor_id=reviewer
     AND event.action='rework.external_responsibility.revision.approved'
     AND event.authorization_capability='external_responsibility:approve_revision'
     AND event.entity_type='rework_order' AND event.entity_id=order_id::text
     AND target.rework_order_id=order_id AND target.status='superseded'
     AND revision.status='pending'
     AND predecessor.rework_order_id=order_id AND predecessor.stage='finalized'
     AND predecessor.determination_version=revision.finalized_determination_version
 )
$$;

DO $$
DECLARE original text; revised text;
BEGIN
 SELECT pg_get_functiondef('guard_determination_insert()'::regprocedure) INTO original;
 revised:=replace(original,
 $old$         AND NOT (event_action='rework.responsibility.reopen' AND external_responsibility_direct_role(event_actor,'external_responsibility:approve_revision',ARRAY['production_management','owner_group']))$old$,
 $new$         AND NOT (event_action='rework.responsibility.reopen' AND external_responsibility_direct_role(event_actor,'external_responsibility:approve_revision',ARRAY['production_management','owner_group']))
         AND NOT (event_action='rework.responsibility.draft' AND external_revision_can_seed_draft(event_actor,NEW.rework_order_id,NEW.replaces_determination_id))$new$);
 IF revised=original THEN RAISE EXCEPTION '0226 determination guard patch target missing'; END IF;
 EXECUTE revised;
END $$;
