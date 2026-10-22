-- Same-factory price requests are distinct from factory changes. No historical DML.
CREATE TABLE sourcing_price_reapplications (
  price_request_id uuid PRIMARY KEY,
  sourcing_case_id uuid NOT NULL REFERENCES sourcing_cases(sourcing_case_id),
  base_decision_id uuid NOT NULL REFERENCES sourcing_decisions(sourcing_decision_id),
  base_document_id uuid NOT NULL REFERENCES sourcing_contract_documents(sourcing_contract_document_id),
  unit_price numeric(18,4) NOT NULL CHECK(unit_price>0),
  requires_owner_approval boolean NOT NULL,
  reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 500),
  requested_by uuid NOT NULL REFERENCES app_users(id),
  operation_event_id uuid NOT NULL UNIQUE REFERENCES operation_events(event_id),
  request_id text NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE sourcing_price_reviews (
  price_request_id uuid PRIMARY KEY REFERENCES sourcing_price_reapplications(price_request_id),
  decision text NOT NULL CHECK(decision IN ('approved','rejected','returned','cancelled')),
  reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 500),
  decided_by uuid NOT NULL REFERENCES app_users(id),
  operation_event_id uuid NOT NULL UNIQUE REFERENCES operation_events(event_id),
  request_id text NOT NULL,
  decided_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX sourcing_price_requests_case_idx ON sourcing_price_reapplications(sourcing_case_id,requested_at DESC);
ALTER TABLE sourcing_decisions ADD COLUMN source_price_request_id uuid UNIQUE REFERENCES sourcing_price_reapplications(price_request_id);
DO $$ DECLARE item record; BEGIN
  FOR item IN SELECT conname FROM pg_constraint WHERE conrelid='sourcing_decisions'::regclass AND contype='c'
    AND pg_get_constraintdef(oid) LIKE '%source_type%' LOOP
    EXECUTE format('ALTER TABLE sourcing_decisions DROP CONSTRAINT %I',item.conname);
  END LOOP;
END $$;
ALTER TABLE sourcing_decisions ADD CONSTRAINT sourcing_decisions_source_type_check
  CHECK(source_type IN ('initial','management_revision','factory_change','price_reapplication'));
ALTER TABLE sourcing_decisions ADD CONSTRAINT sourcing_decisions_source_basis_check CHECK(
  source_type='initial' AND source_ie_quote_id IS NOT NULL AND supersedes_decision_id IS NULL AND source_change_request_id IS NULL AND source_price_request_id IS NULL
  OR source_type='management_revision' AND source_ie_quote_id IS NOT NULL AND supersedes_decision_id IS NOT NULL AND source_change_request_id IS NULL AND source_price_request_id IS NULL
  OR source_type='factory_change' AND source_ie_quote_id IS NULL AND supersedes_decision_id IS NOT NULL AND source_change_request_id IS NOT NULL AND source_price_request_id IS NULL
  OR source_type='price_reapplication' AND source_ie_quote_id IS NULL AND supersedes_decision_id IS NOT NULL AND source_change_request_id IS NULL AND source_price_request_id IS NOT NULL
);

CREATE FUNCTION sourcing_assert_price_basis(case_id uuid,decision_id uuid,document_id uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM sourcing_cases WHERE sourcing_case_id=case_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND OR decision_id IS DISTINCT FROM (SELECT sourcing_decision_id FROM sourcing_decisions WHERE sourcing_case_id=case_id ORDER BY decision_version DESC LIMIT 1)
    OR document_id IS DISTINCT FROM (SELECT sourcing_contract_document_id FROM sourcing_contract_documents WHERE sourcing_case_id=case_id ORDER BY contract_version DESC LIMIT 1)
    OR NOT EXISTS(SELECT 1 FROM sourcing_contract_documents d JOIN sourcing_approval_snapshots approved USING(sourcing_approval_snapshot_id)
      WHERE d.sourcing_contract_document_id=document_id AND d.sourcing_case_id=case_id AND approved.sourcing_decision_id=decision_id)
    OR EXISTS(SELECT 1 FROM sourcing_case_transitions transition JOIN sourcing_decisions decision ON decision.sourcing_decision_id=decision_id
      WHERE transition.sourcing_case_id=case_id AND transition.business_action='returned_to_merchandiser' AND transition.transitioned_at>=decision.decided_at) THEN
    RAISE EXCEPTION 'price request basis changed; refresh the current decision and contract' USING ERRCODE='55000';
  END IF;
END $$;
CREATE FUNCTION guard_sourcing_price_request() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE basis sourcing_decisions%ROWTYPE; event operation_events%ROWTYPE;
BEGIN
  PERFORM sourcing_assert_price_basis(NEW.sourcing_case_id,NEW.base_decision_id,NEW.base_document_id);
  IF EXISTS(SELECT 1 FROM sourcing_price_reapplications request WHERE request.sourcing_case_id=NEW.sourcing_case_id
    AND NOT EXISTS(SELECT 1 FROM sourcing_price_reviews review WHERE review.price_request_id=request.price_request_id)) THEN
    RAISE EXCEPTION 'an unresolved price request must be reviewed or cancelled first' USING ERRCODE='55000';
  END IF;
  SELECT * INTO basis FROM sourcing_decisions WHERE sourcing_decision_id=NEW.base_decision_id;
  SELECT * INTO event FROM operation_events WHERE event_id=NEW.operation_event_id;
  IF NEW.requires_owner_approval IS DISTINCT FROM (NEW.unit_price>basis.unit_price)
    OR NOT EXISTS(SELECT 1 FROM sourcing_decision_lines WHERE sourcing_decision_id=NEW.base_decision_id AND unit_price<>NEW.unit_price)
    OR event.event_id IS NULL OR event.action<>'sourcing.price_reapplication.request' OR event.entity_id<>NEW.sourcing_case_id::text
    OR event.actor_id<>NEW.requested_by OR event.request_id<>NEW.request_id OR event.reason IS DISTINCT FROM NEW.reason
    OR event.authorization_capability<>'sourcing:decision:record'
    OR NOT (event.actor_roles @> ARRAY['root_superuser']::text[] OR event.actor_roles @> ARRAY['production_management']::text[])
    OR event.after_state->>'priceRequestId' IS DISTINCT FROM NEW.price_request_id::text
    OR (event.after_state->>'unitPrice')::numeric IS DISTINCT FROM NEW.unit_price
    OR event.before_state->>'decisionId' IS DISTINCT FROM NEW.base_decision_id::text
    OR event.before_state->>'documentId' IS DISTINCT FROM NEW.base_document_id::text THEN
    RAISE EXCEPTION 'price request requires unchanged approved basis and production-management audit' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sourcing_price_request_guard BEFORE INSERT ON sourcing_price_reapplications FOR EACH ROW EXECUTE FUNCTION guard_sourcing_price_request();
CREATE FUNCTION guard_sourcing_price_review() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE request sourcing_price_reapplications%ROWTYPE; event operation_events%ROWTYPE; owner_action boolean;
BEGIN
  SELECT * INTO request FROM sourcing_price_reapplications WHERE price_request_id=NEW.price_request_id;
  SELECT * INTO event FROM operation_events WHERE event_id=NEW.operation_event_id;
  owner_action:=NEW.decision IN ('rejected','returned') OR NEW.decision='approved' AND request.requires_owner_approval;
  IF request.price_request_id IS NULL OR event.event_id IS NULL OR event.entity_id<>request.sourcing_case_id::text
    OR event.actor_id<>NEW.decided_by OR event.request_id<>NEW.request_id OR event.reason IS DISTINCT FROM NEW.reason
    OR event.action IS DISTINCT FROM (CASE WHEN NEW.decision='approved' THEN 'sourcing.price_reapplication.effective' ELSE 'sourcing.price_reapplication.'||NEW.decision END)
    OR event.after_state->>'priceRequestId' IS DISTINCT FROM NEW.price_request_id::text
    OR NOT (event.actor_roles @> ARRAY['root_superuser']::text[]
      OR owner_action AND event.actor_roles @> ARRAY['owner_group']::text[] AND event.authorization_capability='sourcing:owner:approve'
      OR NOT owner_action AND event.actor_roles @> ARRAY['production_management']::text[] AND event.authorization_capability='sourcing:decision:record')
    OR NEW.decision='cancelled' AND event.actor_id<>request.requested_by AND NOT event.actor_roles @> ARRAY['root_superuser']::text[] THEN
    RAISE EXCEPTION 'price review requires its authorized role and immutable source request' USING ERRCODE='42501';
  END IF;
  IF NEW.decision='approved' THEN PERFORM sourcing_assert_price_basis(request.sourcing_case_id,request.base_decision_id,request.base_document_id); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sourcing_price_review_guard BEFORE INSERT ON sourcing_price_reviews FOR EACH ROW EXECUTE FUNCTION guard_sourcing_price_review();
DO $$ DECLARE name text; BEGIN
  FOREACH name IN ARRAY ARRAY['sourcing_price_reapplications','sourcing_price_reviews'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation()',name||'_immutable',name);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION reject_operation_event_mutation()',name||'_no_truncate',name);
  END LOOP;
END $$;

CREATE FUNCTION sourcing_validate_price_effect(proposed sourcing_decisions) RETURNS void LANGUAGE plpgsql AS $$
DECLARE request sourcing_price_reapplications%ROWTYPE; basis sourcing_decisions%ROWTYPE;
BEGIN
  SELECT * INTO request FROM sourcing_price_reapplications WHERE price_request_id=proposed.source_price_request_id;
  PERFORM sourcing_assert_price_basis(proposed.sourcing_case_id,request.base_decision_id,request.base_document_id);
  SELECT * INTO basis FROM sourcing_decisions WHERE sourcing_decision_id=request.base_decision_id;
  IF request.sourcing_case_id IS DISTINCT FROM proposed.sourcing_case_id
    OR proposed.supersedes_decision_id IS DISTINCT FROM basis.sourcing_decision_id OR proposed.decision_version<>basis.decision_version+1
    OR proposed.unit_price<>request.unit_price
    OR (proposed.supplier_id,proposed.supplier_code_snapshot,proposed.supplier_name_snapshot,proposed.quantity,proposed.crafts,proposed.cutting_process,proposed.cutting_process_other)
      IS DISTINCT FROM (basis.supplier_id,basis.supplier_code_snapshot,basis.supplier_name_snapshot,basis.quantity,basis.crafts,basis.cutting_process,basis.cutting_process_other)
    OR proposed.total_amount IS DISTINCT FROM (SELECT sum(round(line.quantity*request.unit_price,2)) FROM sourcing_decision_lines line WHERE line.sourcing_decision_id=basis.sourcing_decision_id)
    OR NOT EXISTS(SELECT 1 FROM sourcing_price_reviews review JOIN operation_events event ON event.event_id=review.operation_event_id
      WHERE review.price_request_id=request.price_request_id AND review.decision='approved' AND review.operation_event_id=proposed.operation_event_id
        AND event.actor_id=proposed.decided_by AND event.request_id=proposed.request_id AND event.reason IS NOT DISTINCT FROM proposed.decision_reason) THEN
    RAISE EXCEPTION 'price effect must match its approved immutable request without changing non-price facts' USING ERRCODE='55000';
  END IF;
END $$;

CREATE FUNCTION sourcing_price_contract_field(document_id uuid,field text) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT COALESCE(content.content->>(CASE field WHEN 'address' THEN 'partyBAddress' WHEN 'contractEntityName' THEN 'partyBName' ELSE field END),
    supplement.field_value,document.approval_snapshot->>field)
  FROM sourcing_contract_documents document
  LEFT JOIN sourcing_contract_content_overrides content USING(sourcing_contract_document_id)
  LEFT JOIN sourcing_contract_supplements supplement ON supplement.sourcing_contract_document_id=document.sourcing_contract_document_id AND supplement.field_name=field
  WHERE document.sourcing_contract_document_id=document_id
$$;

CREATE FUNCTION guard_sourcing_price_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE decision sourcing_decisions%ROWTYPE; basis sourcing_approval_snapshots%ROWTYPE; document_id uuid;
BEGIN
  SELECT * INTO decision FROM sourcing_decisions WHERE sourcing_decision_id=NEW.sourcing_decision_id;
  IF decision.source_type<>'price_reapplication' THEN RETURN NEW; END IF;
  SELECT approved.* INTO basis FROM sourcing_price_reapplications request JOIN sourcing_approval_snapshots approved ON approved.sourcing_decision_id=request.base_decision_id
    WHERE request.price_request_id=decision.source_price_request_id;
  SELECT base_document_id INTO document_id FROM sourcing_price_reapplications WHERE price_request_id=decision.source_price_request_id;
  IF (NEW.sourcing_case_id,NEW.supplier_id,NEW.supplier_code_snapshot,NEW.supplier_name_snapshot,NEW.supplier_address,NEW.contract_entity_name,
      NEW.party_b_representative,NEW.payee_name,NEW.bank_account,NEW.bank_name,NEW.quantity,NEW.daxing_unit_price,NEW.estimated_cut_piece_send_date,NEW.processes,NEW.gender,NEW.style_name_snapshot)
    IS DISTINCT FROM (basis.sourcing_case_id,basis.supplier_id,basis.supplier_code_snapshot,basis.supplier_name_snapshot,COALESCE(sourcing_price_contract_field(document_id,'address'),basis.supplier_address),COALESCE(sourcing_price_contract_field(document_id,'contractEntityName'),basis.contract_entity_name),
      COALESCE(sourcing_price_contract_field(document_id,'partyBRepresentative'),basis.party_b_representative),COALESCE(sourcing_price_contract_field(document_id,'payeeName'),basis.payee_name),COALESCE(sourcing_price_contract_field(document_id,'bankAccount'),basis.bank_account),COALESCE(sourcing_price_contract_field(document_id,'bankName'),basis.bank_name),basis.quantity,basis.daxing_unit_price,basis.estimated_cut_piece_send_date,basis.processes,basis.gender,basis.style_name_snapshot)
    OR NEW.delivery_date IS DISTINCT FROM sourcing_effective_delivery_date(NEW.sourcing_case_id,basis.delivery_date)
    OR NEW.total_amount<>decision.total_amount OR NEW.decision_version<>decision.decision_version
    OR NEW.operation_event_id<>decision.operation_event_id OR NEW.approved_by<>decision.decided_by OR NEW.request_id<>decision.request_id THEN
    RAISE EXCEPTION 'price approval must preserve the approved non-price contract basis' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sourcing_price_snapshot_guard BEFORE INSERT ON sourcing_approval_snapshots FOR EACH ROW EXECUTE FUNCTION guard_sourcing_price_snapshot();
CREATE OR REPLACE FUNCTION guard_sourcing_decision_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  source_case sourcing_cases%ROWTYPE;
  current_quote sourcing_ie_quotes%ROWTYPE;
  previous_decision sourcing_decisions%ROWTYPE;
  previous_owner_decision sourcing_owner_decisions%ROWTYPE;
  source_change sourcing_factory_change_requests%ROWTYPE;
  source_verification sourcing_factory_change_decisions%ROWTYPE;
BEGIN
  IF NEW.source_type='price_reapplication' THEN
    PERFORM sourcing_validate_price_effect(NEW);
    RETURN NEW;
  END IF;
  PERFORM 1 FROM sourcing_cases WHERE sourcing_case_id=NEW.sourcing_case_id FOR UPDATE;
  SELECT * INTO source_case FROM sourcing_case_facts_at(NEW.sourcing_case_id);
  IF source_case.sourcing_case_id IS NULL OR NEW.quantity<>source_case.order_quantity THEN
    RAISE EXCEPTION 'sourcing decision quantity must match the immutable order quantity'
      USING ERRCODE='23514';
  END IF;
  PERFORM sourcing_require_active_factory(
    NEW.supplier_id,NEW.supplier_code_snapshot,NEW.supplier_name_snapshot
  );
  SELECT * INTO previous_decision
  FROM sourcing_decisions
  WHERE sourcing_case_id=NEW.sourcing_case_id
  ORDER BY decision_version DESC
  LIMIT 1;

  IF NEW.source_type IN ('initial','management_revision') THEN
    SELECT * INTO current_quote
    FROM sourcing_ie_quotes
    WHERE sourcing_case_id=NEW.sourcing_case_id
    ORDER BY quote_version DESC
    LIMIT 1;
    IF sourcing_current_status(NEW.sourcing_case_id)<>'pending_management_decision'
      OR current_quote.sourcing_ie_quote_id IS NULL
      OR NEW.source_ie_quote_id<>current_quote.sourcing_ie_quote_id THEN
      RAISE EXCEPTION 'management decision must reference the current IE quote'
        USING ERRCODE='23514';
    END IF;
    IF NEW.source_type='initial' THEN
      IF previous_decision.sourcing_decision_id IS NOT NULL
        OR NEW.decision_version<>1
        OR NEW.supersedes_decision_id IS NOT NULL THEN
        RAISE EXCEPTION 'first management decision must be version 1'
          USING ERRCODE='23514';
      END IF;
    ELSE
      SELECT * INTO previous_owner_decision
      FROM sourcing_owner_decisions
      WHERE sourcing_decision_id=previous_decision.sourcing_decision_id
        AND decision='rejected';
      IF previous_decision.sourcing_decision_id IS NULL
        OR (previous_owner_decision.sourcing_owner_decision_id IS NULL AND NOT EXISTS(
          SELECT 1 FROM sourcing_case_corrections correction JOIN sourcing_case_transitions transition
            ON transition.operation_event_id=correction.operation_event_id
          WHERE correction.sourcing_case_id=NEW.sourcing_case_id
            AND correction.corrected_at>=previous_decision.decided_at
            AND correction.corrected_at<=current_quote.quoted_at))
        OR NEW.decision_version<>previous_decision.decision_version+1
        OR NEW.supersedes_decision_id<>previous_decision.sourcing_decision_id THEN
        RAISE EXCEPTION 'management revision must supersede the owner-rejected decision'
          USING ERRCODE='23514';
      END IF;
    END IF;
    PERFORM sourcing_require_operation_event(
      NEW.operation_event_id,NEW.request_id,NEW.decided_by,
      'sourcing.management_decision.record','sourcing:decision:record',
      NEW.sourcing_case_id,NEW.decision_reason
    );
  ELSE
    IF previous_decision.sourcing_decision_id IS NULL
      OR NEW.decision_version<>previous_decision.decision_version+1
      OR NEW.supersedes_decision_id<>previous_decision.sourcing_decision_id THEN
      RAISE EXCEPTION 'factory change decision must supersede the current decision'
        USING ERRCODE='23514';
    END IF;
    SELECT * INTO source_change
    FROM sourcing_factory_change_requests
    WHERE factory_change_request_id=NEW.source_change_request_id
      AND sourcing_case_id=NEW.sourcing_case_id
      AND from_decision_id=previous_decision.sourcing_decision_id;
    SELECT * INTO source_verification
    FROM sourcing_factory_change_decisions
    WHERE factory_change_request_id=NEW.source_change_request_id
      AND decision='approved'
      AND operation_event_id=NEW.operation_event_id;
    IF source_change.factory_change_request_id IS NULL
      OR source_verification.factory_change_decision_id IS NULL
      OR (
        (source_change.requires_owner_approval OR source_change.initiator_role='owner_group')
        AND source_verification.decision_role<>'owner_group'
      )
      OR (
        NOT source_change.requires_owner_approval
        AND source_change.initiator_role<>'owner_group'
        AND source_verification.decision_role<>'production_management'
      )
      OR (NEW.supplier_id,NEW.supplier_code_snapshot,NEW.supplier_name_snapshot,
          NEW.unit_price,NEW.quantity,NEW.total_amount)
        IS DISTINCT FROM
         (source_change.proposed_supplier_id,source_change.proposed_supplier_code_snapshot,
          source_change.proposed_supplier_name_snapshot,source_change.proposed_unit_price,
          source_change.proposed_quantity,source_change.proposed_total_amount) THEN
      RAISE EXCEPTION 'effective factory change must match its approved immutable request'
        USING ERRCODE='55000';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM operation_events event_row
      WHERE event_row.event_id=NEW.operation_event_id
        AND event_row.request_id=NEW.request_id
        AND event_row.actor_id=NEW.decided_by
        AND event_row.action='sourcing.factory_change.effective'
        AND event_row.authorization_capability IN (
          'sourcing:decision:record','sourcing:factory_change:verify','sourcing:owner:approve'
        )
        AND event_row.entity_type='sourcing_case'
        AND event_row.entity_id=NEW.sourcing_case_id::text
        AND event_row.reason IS NOT DISTINCT FROM NEW.decision_reason
    ) THEN
      RAISE EXCEPTION 'factory change effect requires its authorized operation event'
        USING ERRCODE='55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION guard_sourcing_decision_crafts() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected jsonb; proposed_event jsonb; current_contract_id text;
BEGIN
  IF NEW.source_type='price_reapplication' THEN
    IF NEW.crafts IS DISTINCT FROM (SELECT crafts FROM sourcing_decisions WHERE sourcing_decision_id=NEW.supersedes_decision_id) THEN
      RAISE EXCEPTION 'price reapplication cannot change crafts' USING ERRCODE='55000';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.source_type='factory_change' THEN
    SELECT COALESCE(event.after_state->'crafts',basis.crafts) INTO expected
    FROM sourcing_factory_change_requests request_row
    JOIN operation_events event ON event.event_id=request_row.operation_event_id
    JOIN sourcing_decisions basis ON basis.sourcing_decision_id=request_row.from_decision_id
    WHERE request_row.factory_change_request_id=NEW.source_change_request_id
      AND request_row.from_decision_id=NEW.supersedes_decision_id;
    SELECT event.after_state INTO proposed_event FROM sourcing_factory_change_requests request_row
    JOIN operation_events event ON event.event_id=request_row.operation_event_id
    WHERE request_row.factory_change_request_id=NEW.source_change_request_id;
    SELECT sourcing_contract_document_id::text INTO current_contract_id FROM sourcing_contract_documents
    WHERE sourcing_case_id=NEW.sourcing_case_id ORDER BY contract_version DESC LIMIT 1;
    IF proposed_event ? 'baseContractDocumentId'
      AND proposed_event->>'baseContractDocumentId' IS DISTINCT FROM current_contract_id THEN
      RAISE EXCEPTION 'factory change contract basis is stale' USING ERRCODE='55000';
    END IF;
    IF NEW.crafts IS DISTINCT FROM expected THEN
      RAISE EXCEPTION 'factory change crafts must match its immutable request' USING ERRCODE='55000';
    END IF;
  ELSIF NEW.crafts IS NOT NULL THEN
    SELECT jsonb_agg(jsonb_build_object(
      'position',requested.position,'craftId',catalog.craft_id,'craftCode',catalog.craft_code,
      'craftVersion',catalog.version,'craftName',catalog.craft_name
    ) ORDER BY requested.position) INTO expected
    FROM jsonb_array_elements(NEW.crafts) WITH ORDINALITY requested(craft,position)
    JOIN current_craft_catalog catalog ON catalog.craft_id=(requested.craft->>'craftId')::uuid AND catalog.active;
    IF expected IS DISTINCT FROM NEW.crafts
      OR (SELECT count(DISTINCT craft->>'craftId') FROM jsonb_array_elements(NEW.crafts) craft)<>jsonb_array_length(NEW.crafts)
      OR NOT EXISTS(SELECT 1 FROM operation_events event WHERE event.event_id=NEW.operation_event_id
        AND event.actor_id=NEW.decided_by AND event.request_id=NEW.request_id
        AND event.action='sourcing.management_decision.record'
        AND event.authorization_capability='sourcing:decision:record'
        AND event.after_state->'crafts'=NEW.crafts)
    THEN RAISE EXCEPTION 'decision crafts require matching catalog and audit' USING ERRCODE='55000'; END IF;
  ELSIF EXISTS(SELECT 1 FROM sourcing_cases WHERE sourcing_case_id=NEW.sourcing_case_id AND gender IS NOT NULL) THEN
    RAISE EXCEPTION 'new order decisions require confirmed crafts' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION guard_sourcing_cutting_process() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected_kind text; expected_other text;
BEGIN
  IF NEW.source_type IN ('factory_change','price_reapplication') THEN
    SELECT cutting_process,cutting_process_other INTO expected_kind,expected_other
    FROM sourcing_decisions WHERE sourcing_decision_id=NEW.supersedes_decision_id;
  ELSE
    SELECT after_state->>'cuttingProcess',after_state->>'cuttingProcessOther'
    INTO expected_kind,expected_other FROM operation_events WHERE event_id=NEW.operation_event_id;
  END IF;
  IF NEW.cutting_process IS DISTINCT FROM expected_kind
     OR NEW.cutting_process_other IS DISTINCT FROM expected_other THEN
    RAISE EXCEPTION 'cutting process must match management audit or previous decision' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION guard_sourcing_transition_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  previous_transition sourcing_case_transitions%ROWTYPE;
  expected_from text;
  expected_to text;
  expected_event_action text;
  expected_capability text;
  supporting_fact_exists boolean := true;
BEGIN
  IF NEW.business_action='price_reapplication_effective' THEN
    PERFORM 1 FROM sourcing_cases WHERE sourcing_case_id=NEW.sourcing_case_id FOR UPDATE;
    SELECT * INTO previous_transition FROM sourcing_case_transitions WHERE sourcing_case_id=NEW.sourcing_case_id ORDER BY sequence DESC LIMIT 1;
    IF NEW.sequence<>previous_transition.sequence+1 OR NEW.from_status IS DISTINCT FROM previous_transition.to_status
      OR NEW.to_status<>'pending_finance_reconciliation' OR NOT EXISTS(
        SELECT 1 FROM sourcing_decisions decision JOIN operation_events event ON event.event_id=decision.operation_event_id
        WHERE decision.sourcing_case_id=NEW.sourcing_case_id AND decision.source_type='price_reapplication'
          AND decision.operation_event_id=NEW.operation_event_id AND event.actor_id=NEW.actor_id AND event.request_id=NEW.request_id
      ) THEN RAISE EXCEPTION 'price effect transition requires its approved version and current order state' USING ERRCODE='55000'; END IF;
    RETURN NEW;
  END IF;
  PERFORM 1 FROM sourcing_cases
  WHERE sourcing_case_id=NEW.sourcing_case_id FOR UPDATE;
  SELECT * INTO previous_transition
  FROM sourcing_case_transitions
  WHERE sourcing_case_id=NEW.sourcing_case_id
  ORDER BY sequence DESC
  LIMIT 1;

  IF previous_transition.sourcing_transition_id IS NULL THEN
    IF NEW.sequence<>1 OR NEW.from_status IS NOT NULL
      OR NEW.to_status<>'pending_ie_quote' OR NEW.business_action<>'created' THEN
      RAISE EXCEPTION 'first sourcing transition must create a pending IE quote case'
        USING ERRCODE='23514';
    END IF;
  ELSIF NEW.sequence<>previous_transition.sequence+1
    OR NEW.from_status IS DISTINCT FROM previous_transition.to_status THEN
    RAISE EXCEPTION 'sourcing transitions must be sequential from current state'
      USING ERRCODE='23514';
  END IF;

  IF NEW.business_action='contract_content_revised' THEN
    IF NEW.from_status NOT IN ('closed','pending_exception_verification') OR NEW.to_status<>'pending_finance_reconciliation' THEN
      RAISE EXCEPTION 'contract revision must reopen the financial review stage' USING ERRCODE='23514';
    END IF;
    PERFORM sourcing_require_operation_event(NEW.operation_event_id,NEW.request_id,NEW.actor_id,
      'sourcing.contract.content.revise','sourcing:contract:record',NEW.sourcing_case_id,NEW.transition_reason);
    IF NOT EXISTS(SELECT 1 FROM operation_events e
      JOIN sourcing_contract_documents d ON d.sourcing_contract_document_id=(e.after_state->>'documentId')::uuid
      JOIN sourcing_contract_content_overrides c USING(sourcing_contract_document_id)
      JOIN operation_events edit ON edit.event_id=c.operation_event_id
      WHERE e.event_id=NEW.operation_event_id AND e.actor_roles @> ARRAY['root_superuser']::text[]
        AND d.sourcing_case_id=NEW.sourcing_case_id AND d.prepared_by=NEW.actor_id
        AND d.revision_of::text=e.before_state->>'documentId' AND edit.after_state->>'mode'='manual_content'
        AND d.status='generation_pending' AND d.sourcing_contract_document_id=(SELECT sourcing_contract_document_id
          FROM sourcing_contract_documents WHERE sourcing_case_id=NEW.sourcing_case_id ORDER BY contract_version DESC LIMIT 1)
    ) THEN RAISE EXCEPTION 'financial review reopen requires the new root contract revision' USING ERRCODE='42501'; END IF;
    RETURN NEW;
  END IF;

  IF NEW.business_action IN ('returned_to_merchandiser','correction_submitted') THEN
    IF EXISTS(SELECT 1 FROM sourcing_approval_snapshots WHERE sourcing_case_id=NEW.sourcing_case_id) THEN
      RAISE EXCEPTION 'approved facts cannot be returned' USING ERRCODE='55000';
    END IF;
    IF NEW.business_action='returned_to_merchandiser' THEN
      IF NEW.from_status NOT IN ('pending_ie_quote','pending_management_decision','pending_owner_approval')
        OR NEW.to_status<>'pending_merchandiser_correction' THEN
        RAISE EXCEPTION 'invalid correction return' USING ERRCODE='23514'; END IF;
      PERFORM sourcing_require_operation_event(NEW.operation_event_id,NEW.request_id,NEW.actor_id,
        'sourcing.case.return','sourcing:owner:approve',NEW.sourcing_case_id,NEW.transition_reason);
      IF NOT EXISTS(SELECT 1 FROM operation_events WHERE event_id=NEW.operation_event_id
        AND (actor_roles && ARRAY['root_superuser','owner_group']::text[])) THEN
        RAISE EXCEPTION 'return requires owner authority' USING ERRCODE='55000'; END IF;
    ELSE
      IF NEW.from_status<>'pending_merchandiser_correction' OR NEW.to_status<>'pending_ie_quote'
        OR NOT EXISTS(SELECT 1 FROM sourcing_case_corrections WHERE operation_event_id=NEW.operation_event_id
          AND sourcing_case_id=NEW.sourcing_case_id) THEN
        RAISE EXCEPTION 'resubmission requires correction fact' USING ERRCODE='23514'; END IF;
      PERFORM sourcing_require_operation_event(NEW.operation_event_id,NEW.request_id,NEW.actor_id,
        'sourcing.case.correct','sourcing:inquiry:create',NEW.sourcing_case_id,NEW.transition_reason);
    END IF;
    IF NEW.transition_reason IS NULL OR length(btrim(NEW.transition_reason)) NOT BETWEEN 1 AND 500 THEN
      RAISE EXCEPTION 'correction reason required' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;

  IF NEW.business_action='factory_change_effective' THEN
    IF NOT (
      (NEW.from_status='pending_management_decision'
        AND NEW.to_status IN ('pending_owner_approval','pending_finance_reconciliation'))
      OR (NEW.from_status IN (
        'pending_owner_approval','pending_factory_change_verification',
        'pending_exception_verification','closed'
      ) AND NEW.to_status='pending_finance_reconciliation')
    )
      OR NOT EXISTS (
        SELECT 1
        FROM sourcing_decisions decision_row
        JOIN sourcing_factory_change_requests request_row
          ON request_row.factory_change_request_id=decision_row.source_change_request_id
        WHERE decision_row.sourcing_case_id=NEW.sourcing_case_id
          AND decision_row.operation_event_id=NEW.operation_event_id
          AND decision_row.source_type='factory_change'
      )
      OR NOT EXISTS (
        SELECT 1 FROM operation_events event_row
        WHERE event_row.event_id=NEW.operation_event_id
          AND event_row.request_id=NEW.request_id
          AND event_row.actor_id=NEW.actor_id
          AND event_row.action='sourcing.factory_change.effective'
          AND event_row.authorization_capability IN (
            'sourcing:decision:record','sourcing:factory_change:verify','sourcing:owner:approve'
          )
          AND event_row.entity_type='sourcing_case'
          AND event_row.entity_id=NEW.sourcing_case_id::text
          AND event_row.reason IS NOT DISTINCT FROM NEW.transition_reason
          AND (
            NEW.from_status<>'pending_management_decision'
            OR (
              event_row.authorization_capability='sourcing:owner:approve'
              AND NEW.to_status='pending_finance_reconciliation'
            )
            OR (
              event_row.authorization_capability<>'sourcing:owner:approve'
              AND NEW.to_status='pending_owner_approval'
            )
          )
      ) THEN
      RAISE EXCEPTION 'effective factory change must refresh the approved decision'
        USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;

  SELECT rule.from_status,rule.to_status,rule.event_action,rule.capability
  INTO expected_from,expected_to,expected_event_action,expected_capability
  FROM (VALUES
    ('created',NULL::text,'pending_ie_quote','sourcing.case.create','sourcing:inquiry:create'),
    ('ie_price_quoted','pending_ie_quote','pending_management_decision','sourcing.ie_price.quote','sourcing:price:quote'),
    ('management_decision_recorded','pending_management_decision','pending_owner_approval','sourcing.management_decision.record','sourcing:decision:record'),
    ('owner_approved','pending_owner_approval','pending_finance_reconciliation','sourcing.owner.approve','sourcing:owner:approve'),
    ('owner_rejected','pending_owner_approval','pending_management_decision','sourcing.owner.reject','sourcing:owner:approve'),
    ('contract_recorded','pending_contract','pending_finance_reconciliation','sourcing.contract.record','sourcing:contract:record'),
    ('contract_stage_retired','pending_contract','pending_finance_reconciliation','sourcing.contract_stage.retire','system:migration'),
    ('factory_change_requested','pending_finance_reconciliation','pending_factory_change_verification','sourcing.factory_change.request','sourcing:factory_change:request'),
    ('factory_change_approved','pending_factory_change_verification','pending_finance_reconciliation','sourcing.factory_change.approved','sourcing:factory_change:verify'),
    ('factory_change_rejected','pending_factory_change_verification','pending_finance_reconciliation','sourcing.factory_change.rejected','sourcing:factory_change:verify'),
    ('finance_matched','pending_finance_reconciliation','closed','sourcing.finance.matched','sourcing:finance:reconcile'),
    ('finance_difference','pending_finance_reconciliation','pending_exception_verification','sourcing.finance.difference','sourcing:finance:reconcile'),
    ('exception_reopened_for_contract','pending_exception_verification','pending_contract','sourcing.exception.reopen_contract','sourcing:exception:verify'),
    ('exception_reopened_for_reconciliation','pending_exception_verification','pending_finance_reconciliation','sourcing.exception.reopen_reconciliation','sourcing:exception:verify'),
    ('exception_closed','pending_exception_verification','closed','sourcing.exception.close','sourcing:exception:verify')
  ) AS rule(action,from_status,to_status,event_action,capability)
  WHERE rule.action=NEW.business_action;

  IF expected_event_action IS NULL
    OR NEW.from_status IS DISTINCT FROM expected_from
    OR NEW.to_status<>expected_to THEN
    RAISE EXCEPTION 'sourcing state transition is not allowed'
      USING ERRCODE='23514';
  END IF;

  supporting_fact_exists := CASE NEW.business_action
    WHEN 'created' THEN EXISTS(
      SELECT 1 FROM sourcing_cases source_case
      WHERE source_case.sourcing_case_id=NEW.sourcing_case_id
        AND source_case.operation_event_id=NEW.operation_event_id
    )
    WHEN 'ie_price_quoted' THEN EXISTS(
      SELECT 1 FROM sourcing_ie_quotes quote_row
      WHERE quote_row.sourcing_case_id=NEW.sourcing_case_id
        AND quote_row.operation_event_id=NEW.operation_event_id
    )
    WHEN 'management_decision_recorded' THEN EXISTS(
      SELECT 1 FROM sourcing_decisions decision_row
      WHERE decision_row.sourcing_case_id=NEW.sourcing_case_id
        AND decision_row.operation_event_id=NEW.operation_event_id
        AND decision_row.source_type IN ('initial','management_revision')
    )
    WHEN 'owner_approved' THEN EXISTS(
      SELECT 1 FROM sourcing_owner_decisions owner_decision
      WHERE owner_decision.sourcing_case_id=NEW.sourcing_case_id
        AND owner_decision.operation_event_id=NEW.operation_event_id
        AND owner_decision.decision='approved'
    )
    WHEN 'owner_rejected' THEN EXISTS(
      SELECT 1 FROM sourcing_owner_decisions owner_decision
      WHERE owner_decision.sourcing_case_id=NEW.sourcing_case_id
        AND owner_decision.operation_event_id=NEW.operation_event_id
        AND owner_decision.decision='rejected'
    )
    WHEN 'contract_stage_retired' THEN true
    WHEN 'contract_recorded' THEN EXISTS(
      SELECT 1 FROM sourcing_contract_executions contract_row
      WHERE contract_row.sourcing_case_id=NEW.sourcing_case_id
        AND contract_row.operation_event_id=NEW.operation_event_id
    )
    WHEN 'factory_change_requested' THEN EXISTS(
      SELECT 1 FROM sourcing_factory_change_requests request_row
      WHERE request_row.sourcing_case_id=NEW.sourcing_case_id
        AND request_row.operation_event_id=NEW.operation_event_id
    )
    WHEN 'factory_change_approved' THEN EXISTS(
      SELECT 1
      FROM sourcing_factory_change_decisions verification
      JOIN sourcing_factory_change_requests request_row
        ON request_row.factory_change_request_id=verification.factory_change_request_id
      JOIN sourcing_decisions decision_row
        ON decision_row.source_change_request_id=request_row.factory_change_request_id
       AND decision_row.operation_event_id=verification.operation_event_id
      WHERE request_row.sourcing_case_id=NEW.sourcing_case_id
        AND verification.operation_event_id=NEW.operation_event_id
        AND verification.decision='approved'
    )
    WHEN 'factory_change_rejected' THEN EXISTS(
      SELECT 1
      FROM sourcing_factory_change_decisions verification
      JOIN sourcing_factory_change_requests request_row
        ON request_row.factory_change_request_id=verification.factory_change_request_id
      WHERE request_row.sourcing_case_id=NEW.sourcing_case_id
        AND verification.operation_event_id=NEW.operation_event_id
        AND verification.decision='rejected'
    )
    WHEN 'finance_matched' THEN EXISTS(
      SELECT 1 FROM sourcing_finance_reconciliations reconciliation
      WHERE reconciliation.sourcing_case_id=NEW.sourcing_case_id
        AND reconciliation.operation_event_id=NEW.operation_event_id
        AND reconciliation.result='match'
    )
    WHEN 'finance_difference' THEN EXISTS(
      SELECT 1 FROM sourcing_finance_reconciliations reconciliation
      WHERE reconciliation.sourcing_case_id=NEW.sourcing_case_id
        AND reconciliation.operation_event_id=NEW.operation_event_id
        AND reconciliation.result='difference'
    )
    ELSE true
  END;

  IF supporting_fact_exists IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'sourcing transition requires its matching immutable business fact'
      USING ERRCODE='55000';
  END IF;

  PERFORM sourcing_require_operation_event(
    NEW.operation_event_id,NEW.request_id,NEW.actor_id,
    expected_event_action,expected_capability,
    NEW.sourcing_case_id,NEW.transition_reason
  );
  RETURN NEW;
END;
$$;

DO $$ DECLARE item record; expression text; BEGIN
  FOR item IN SELECT conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='sourcing_case_transitions'::regclass
    AND contype='c' AND pg_get_constraintdef(oid) LIKE '%business_action%' LOOP
    expression:=substring(item.definition FROM 8 FOR length(item.definition)-8);
    EXECUTE format('ALTER TABLE sourcing_case_transitions DROP CONSTRAINT %I',item.conname);
    EXECUTE format('ALTER TABLE sourcing_case_transitions ADD CONSTRAINT %I CHECK ((%s) OR business_action=''price_reapplication_effective'')',item.conname,expression);
  END LOOP;
END $$;
