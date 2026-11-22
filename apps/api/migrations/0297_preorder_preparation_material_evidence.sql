-- Reserve-stage preorder material evidence remains local to the original source.
-- The first-publication, enrollment and responsibility guards stay in force.
CREATE OR REPLACE FUNCTION guard_preparation_evidence_identity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous digital_preparation_material_versions; origin audit_events;
BEGIN
 IF NEW.resource_kind='order' THEN
  IF NOT EXISTS(SELECT 1 FROM digital_production_orders WHERE production_order_id=NEW.resource_id) THEN RAISE EXCEPTION 'preparation order missing' USING ERRCODE='23514';END IF;
 ELSE
  IF NOT EXISTS(SELECT 1 FROM digital_production_sources WHERE source_id=NEW.resource_id) THEN RAISE EXCEPTION 'preparation source missing' USING ERRCODE='23514';END IF;
  IF EXISTS(SELECT 1 FROM digital_development_source_lifecycle WHERE source_id=NEW.resource_id AND is_draft) THEN
   IF TG_TABLE_NAME<>'digital_preparation_material_versions' THEN
    RAISE EXCEPTION 'preparation source not published' USING ERRCODE='23514';
   END IF;
   IF NEW.kind NOT IN ('design_handover','material_investment') OR NEW.scope_ref<>'whole'
    OR NOT EXISTS(SELECT 1 FROM digital_development_documents d WHERE d.source_id=NEW.resource_id AND d.status='draft'
      AND d.document->'customerOrderDraft'->>'withOrder'='true' AND d.document->'customerOrderDraft'->>'stage'='preorder'
      AND (NEW.kind<>'design_handover' OR NEW.state<>'ready' OR d.version::text=NEW.body->>'sourceDocumentVersion')
      AND EXISTS(SELECT 1 FROM jsonb_array_elements(d.document->'materials') item
        WHERE item->>'category'<>'辅料' AND btrim(item->>'name')<>'' AND btrim(item->>'quantity')<>''))
   THEN RAISE EXCEPTION 'preparation draft only permits current preorder material evidence' USING ERRCODE='23514'; END IF;
   IF NEW.kind='material_investment' AND NOT EXISTS(
    SELECT 1 FROM (SELECT h.state,h.body FROM digital_preparation_material_versions h
     WHERE h.resource_kind='source' AND h.resource_id=NEW.resource_id AND h.kind='design_handover' AND h.scope_ref='whole'
     ORDER BY h.version DESC LIMIT 1) h
    WHERE h.state='ready' AND h.body->'investmentScopeBasis'->>'fingerprint'=NEW.body->'investmentScopeBasis'->>'fingerprint'
   ) THEN RAISE EXCEPTION 'preorder investment requires its effective handover' USING ERRCODE='23514'; END IF;
  END IF;
 END IF;
 IF TG_TABLE_NAME='digital_preparation_material_versions' THEN
  PERFORM pg_advisory_xact_lock(hashtextextended('preparation-material:'||NEW.resource_kind||':'||NEW.resource_id::text||':'||NEW.kind||':'||NEW.scope_ref,0));
  SELECT * INTO previous FROM digital_preparation_material_versions WHERE resource_kind=NEW.resource_kind AND resource_id=NEW.resource_id AND kind=NEW.kind AND scope_ref=NEW.scope_ref ORDER BY version DESC LIMIT 1;
  IF previous.record_id IS NULL THEN
   IF NEW.version<>1 THEN RAISE EXCEPTION 'preparation first version must be one' USING ERRCODE='23514';END IF;
  ELSIF NEW.record_id<>previous.record_id OR NEW.version<>previous.version+1 THEN
   RAISE EXCEPTION 'preparation correction must append current same-scope record' USING ERRCODE='23514';
  END IF;
 ELSIF TG_TABLE_NAME='digital_preparation_rule_adoptions' THEN
 IF NEW.creation_event_id IS NOT NULL THEN
  SELECT * INTO origin FROM audit_events WHERE id=NEW.creation_event_id;
  IF origin IS NULL OR origin.entity_id<>NEW.resource_id::text OR NOT (
   (origin.actor_id=NEW.adopted_by AND origin.action=(CASE WHEN NEW.resource_kind='order' THEN 'digital_order_created' ELSE 'digital_source_created' END))
   OR (NEW.resource_kind='source' AND origin.action='digital_development_first_published'
    AND origin.after_state->>'createdBy'=NEW.adopted_by::text
    AND EXISTS(SELECT 1 FROM digital_development_first_publications WHERE source_id=NEW.resource_id AND event_id=origin.id))
  ) THEN
   RAISE EXCEPTION 'preparation enrollment needs its original creation event' USING ERRCODE='23514';
  END IF;
 END IF;
 END IF;
 RETURN NEW;
END $$;
