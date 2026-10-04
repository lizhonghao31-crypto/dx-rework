-- Freeze optional transfer craft changes in the existing immutable request audit.
-- Legacy requests without crafts retain their original decision, including NULL.
-- Price routing, roles, approval and finance guards are deliberately unchanged.
CREATE FUNCTION guard_sourcing_factory_change_crafts() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE proposed jsonb; expected jsonb;
BEGIN
  SELECT after_state->'crafts' INTO proposed FROM operation_events WHERE event_id=NEW.operation_event_id;
  IF proposed IS NULL THEN RETURN NEW; END IF;
  IF jsonb_typeof(proposed)<>'array' THEN
    RAISE EXCEPTION 'factory change crafts must be an array' USING ERRCODE='23514';
  END IF;
  IF jsonb_array_length(proposed) NOT BETWEEN 1 AND 20 THEN
    RAISE EXCEPTION 'factory change requires 1..20 crafts' USING ERRCODE='23514';
  END IF;
  SELECT jsonb_agg(jsonb_build_object(
    'position',requested.position,'craftId',catalog.craft_id,'craftCode',catalog.craft_code,
    'craftVersion',catalog.version,'craftName',catalog.craft_name
  ) ORDER BY requested.position) INTO expected
  FROM jsonb_array_elements(proposed) WITH ORDINALITY requested(craft,position)
  JOIN current_craft_catalog catalog ON catalog.craft_id=(requested.craft->>'craftId')::uuid AND catalog.active;
  IF expected IS DISTINCT FROM proposed
    OR (SELECT count(DISTINCT craft->>'craftId') FROM jsonb_array_elements(proposed) craft)<>jsonb_array_length(proposed)
  THEN RAISE EXCEPTION 'factory change crafts require matching active catalog snapshots' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sourcing_factory_change_requests_guard_crafts BEFORE INSERT ON sourcing_factory_change_requests
  FOR EACH ROW EXECUTE FUNCTION guard_sourcing_factory_change_crafts();

CREATE OR REPLACE FUNCTION guard_sourcing_decision_crafts() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected jsonb; proposed_event jsonb; current_contract_id text;
BEGIN
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
