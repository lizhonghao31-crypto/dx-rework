-- Manual edits preserve the template actually applied; only explicit refresh advances it.
CREATE OR REPLACE FUNCTION guard_sourcing_contract_information_refresh() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous sourcing_contract_documents%ROWTYPE; event operation_events%ROWTYPE;
  creator uuid; returned boolean; fields text[]:=ARRAY['supplierName','supplierCode','address','contractEntityName','partyBRepresentative','payeeName','bankAccount','bankName'];
BEGIN
  IF TG_OP='UPDATE' THEN
    IF NEW.information_revision<>OLD.information_revision OR NEW.information_refresh_event_id IS DISTINCT FROM OLD.information_refresh_event_id THEN
      RAISE EXCEPTION 'contract supplier revision is immutable' USING ERRCODE='55000';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.information_revision=0 AND NEW.information_refresh_event_id IS NULL THEN RETURN NEW; END IF;
  SELECT created_by INTO creator FROM sourcing_cases WHERE sourcing_case_id=NEW.sourcing_case_id AND deleted_at IS NULL FOR UPDATE;
  PERFORM 1 FROM sourcing_contract_return_monitors WHERE sourcing_case_id=NEW.sourcing_case_id FOR UPDATE;
  returned:=EXISTS(SELECT 1 FROM sourcing_contract_return_submissions WHERE sourcing_case_id=NEW.sourcing_case_id);
  SELECT * INTO previous FROM sourcing_contract_documents WHERE sourcing_case_id=NEW.sourcing_case_id ORDER BY contract_version DESC LIMIT 1;
  SELECT * INTO event FROM operation_events WHERE event_id=NEW.information_refresh_event_id;
  IF creator IS NULL OR previous.sourcing_contract_document_id IS NULL OR event.event_id IS NULL
    OR event.action<>'sourcing.contract.information.refresh' OR event.entity_type<>'sourcing_contract_document'
    OR event.entity_id<>NEW.sourcing_contract_document_id::text OR event.actor_id<>NEW.prepared_by
    OR event.before_state->>'documentId' IS DISTINCT FROM previous.sourcing_contract_document_id::text
    OR event.after_state->'supplierValues' IS DISTINCT FROM (
      SELECT jsonb_object_agg(key,value) FROM jsonb_each(NEW.approval_snapshot) WHERE key=ANY(fields))
    OR NOT (event.actor_roles @> ARRAY['root_superuser']::text[] OR (NOT returned AND (
      event.actor_roles @> ARRAY['production_management']::text[] AND event.authorization_capability='sourcing:decision:record'
      OR event.actor_roles @> ARRAY['order_merchandiser']::text[] AND event.actor_id=creator AND event.authorization_capability='sourcing:contract:record')))
    OR NEW.revision_of IS DISTINCT FROM previous.sourcing_contract_document_id
    OR NEW.information_revision<>previous.information_revision+1 OR NEW.contract_version<>previous.contract_version+1
    OR NEW.sourcing_approval_snapshot_id<>previous.sourcing_approval_snapshot_id
    OR NEW.sourcing_decision_id<>previous.sourcing_decision_id OR NEW.identity_version<>previous.identity_version
    OR (event.after_state->>'mode'='manual_content' AND (
      NOT event.actor_roles @> ARRAY['root_superuser']::text[]
      OR EXISTS(SELECT 1 FROM sourcing_finance_reconciliations WHERE sourcing_case_id=NEW.sourcing_case_id)))
    OR NEW.template_version IS DISTINCT FROM (CASE WHEN event.after_state->>'mode'='manual_content'
      THEN previous.template_version
      ELSE (SELECT max(template_version) FROM sourcing_contract_template_versions WHERE effective_from<=CURRENT_TIMESTAMP) END)
    OR (event.after_state->>'templateVersion')::integer IS DISTINCT FROM NEW.template_version
    OR (NEW.approval_snapshot-fields) IS DISTINCT FROM (previous.approval_snapshot-fields)
  THEN RAISE EXCEPTION 'supplier refresh requires authorized unchanged contract and audit' USING ERRCODE='42501'; END IF;
  RETURN NEW;
END $$;
