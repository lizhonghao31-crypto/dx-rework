-- New templates apply to future contract preparation; never replace historical PDFs.
ALTER TABLE sourcing_contract_template_versions ADD COLUMN operation_event_id uuid UNIQUE REFERENCES operation_events(event_id);
INSERT INTO sourcing_contract_template_versions(
  template_version,template_name,party_a_name,party_a_address,signing_place,terms,effective_from)
SELECT 4,'服装加工合同 V4（运费修正）',party_a_name,party_a_address,signing_place,
  jsonb_set(terms,'{logistics}',to_jsonb('甲乙双方各负责一程运费；（备注：甲方负责送货到物流公司并且安排发货，发物流费用由甲方支付，乙方负责把做好的成品发物流回来，回货物流费用由乙方支付）。'::text))
    || jsonb_build_object('processingResponsibility','乙方负责{{工艺}}，甲方提供样板及面/辅料。'),CURRENT_TIMESTAMP
FROM sourcing_contract_template_versions WHERE template_version=3;

CREATE FUNCTION guard_sourcing_template_creation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE event operation_events%ROWTYPE;
BEGIN
  SELECT * INTO event FROM operation_events WHERE event_id=NEW.operation_event_id;
  IF event.event_id IS NULL OR NOT event.actor_roles @> ARRAY['root_superuser']::text[]
    OR event.action<>'sourcing.contract.template.save' OR event.entity_type<>'sourcing_contract_template'
    OR event.entity_id<>NEW.template_version::text
    OR (event.after_state->>'templateVersion')::integer<>NEW.template_version
    OR event.after_state->>'templateName' IS DISTINCT FROM NEW.template_name
    OR event.after_state->>'partyAName' IS DISTINCT FROM NEW.party_a_name
    OR event.after_state->>'partyAAddress' IS DISTINCT FROM NEW.party_a_address
    OR event.after_state->>'signingPlace' IS DISTINCT FROM NEW.signing_place
    OR event.after_state->'terms' IS DISTINCT FROM NEW.terms THEN
    RAISE EXCEPTION 'contract template requires root creation audit' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sourcing_template_creation BEFORE INSERT ON sourcing_contract_template_versions
  FOR EACH ROW WHEN (NEW.template_version>4) EXECUTE FUNCTION guard_sourcing_template_creation();

ALTER TABLE sourcing_contract_documents
  ADD COLUMN information_revision integer NOT NULL DEFAULT 0 CHECK(information_revision>=0),
  ADD COLUMN information_refresh_event_id uuid UNIQUE REFERENCES operation_events(event_id),
  DROP CONSTRAINT sourcing_contract_revision_unique,
  ADD CONSTRAINT sourcing_contract_revision_unique UNIQUE(sourcing_approval_snapshot_id,identity_version,template_version,information_revision);

CREATE FUNCTION guard_sourcing_contract_information_refresh() RETURNS trigger LANGUAGE plpgsql AS $$
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
    OR NEW.template_version<>(SELECT max(template_version) FROM sourcing_contract_template_versions WHERE effective_from<=CURRENT_TIMESTAMP)
    OR (event.after_state->>'templateVersion')::integer IS DISTINCT FROM NEW.template_version
    OR (NEW.approval_snapshot-fields) IS DISTINCT FROM (previous.approval_snapshot-fields)
  THEN RAISE EXCEPTION 'supplier refresh requires authorized unchanged contract and audit' USING ERRCODE='42501'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sourcing_contract_information_refresh_guard BEFORE INSERT OR UPDATE ON sourcing_contract_documents
  FOR EACH ROW EXECUTE FUNCTION guard_sourcing_contract_information_refresh();

-- Future returns identify the document signed. Legacy evidence has no recorded
-- version: keep it unbound rather than guessing from timestamps or the current PDF.
ALTER TABLE sourcing_contract_return_submissions
  ADD COLUMN sourcing_contract_document_id uuid REFERENCES sourcing_contract_documents(sourcing_contract_document_id);

CREATE FUNCTION guard_sourcing_contract_return_document() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
    IF NEW.sourcing_contract_document_id IS DISTINCT FROM OLD.sourcing_contract_document_id THEN
      RAISE EXCEPTION 'signed contract document binding is immutable' USING ERRCODE='55000';
    END IF;
  ELSIF NEW.sourcing_contract_document_id IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM sourcing_contract_documents WHERE sourcing_contract_document_id=NEW.sourcing_contract_document_id
      AND sourcing_case_id=NEW.sourcing_case_id
  ) THEN
    RAISE EXCEPTION 'signed contract document must belong to the same order' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sourcing_contract_return_document_guard
  BEFORE INSERT OR UPDATE OF sourcing_contract_document_id ON sourcing_contract_return_submissions
  FOR EACH ROW EXECUTE FUNCTION guard_sourcing_contract_return_document();
