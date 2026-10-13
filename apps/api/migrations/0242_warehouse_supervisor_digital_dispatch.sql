-- Preserve digital warehouse dispatch provenance; add the supervisor role only.
-- No employee, task, PO, cutting, contract or historical business fact is changed.
CREATE OR REPLACE FUNCTION guard_sourcing_production_creation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_case sourcing_cases%ROWTYPE;
BEGIN
  SELECT * INTO source_case FROM sourcing_cases WHERE sourcing_case_id=NEW.sourcing_case_id FOR UPDATE;
  IF source_case.deleted_at IS NOT NULL OR NOT EXISTS (
    SELECT 1 FROM sourcing_approval_snapshots snapshot
    JOIN sourcing_contract_documents document USING(sourcing_approval_snapshot_id)
    JOIN operation_events event ON event.event_id=NEW.operation_event_id
    WHERE snapshot.sourcing_approval_snapshot_id=NEW.sourcing_approval_snapshot_id
      AND snapshot.sourcing_case_id=NEW.sourcing_case_id
      AND snapshot.sourcing_decision_id=NEW.sourcing_decision_id
      AND snapshot.decision_version=NEW.decision_version
      AND snapshot.sourcing_decision_id=(SELECT sourcing_decision_id FROM sourcing_decisions
        WHERE sourcing_case_id=NEW.sourcing_case_id ORDER BY decision_version DESC LIMIT 1)
      AND document.sourcing_contract_document_id=NEW.sourcing_contract_document_id
      AND document.status='ready' AND document.pdf_attachment_id IS NOT NULL
      AND document.contract_number=NEW.contract_number AND document.contract_version=NEW.contract_version
      AND snapshot.supplier_id=NEW.supplier_id AND snapshot.supplier_name_snapshot=NEW.supplier_name_snapshot
      AND snapshot.quantity=NEW.quantity AND snapshot.processes=NEW.processes
      AND snapshot.delivery_date IS NOT DISTINCT FROM NEW.delivery_date
      AND snapshot.gender IS NOT DISTINCT FROM NEW.gender
      AND snapshot.style_name_snapshot IS NOT DISTINCT FROM NEW.style_name_snapshot
      AND NEW.first_style_no=(SELECT style_no FROM sourcing_approval_snapshot_lines
        WHERE sourcing_approval_snapshot_id=NEW.sourcing_approval_snapshot_id ORDER BY position LIMIT 1)
      AND event.action='sourcing.production.dispatch' AND event.entity_type='sourcing_production_order'
      AND event.entity_id=NEW.production_order_id::text AND event.actor_id=NEW.dispatched_by
      AND event.authorization_capability='sourcing:contract:record'
      AND (CASE WHEN source_case.workflow_generation='digital_production_v1' THEN
        (event.actor_roles && ARRAY['root_superuser','warehouse_receiver','warehouse_supervisor']::text[] AND EXISTS(
          SELECT 1 FROM digital_production_child_links l JOIN digital_factory_routes r USING(production_order_id)
          JOIN digital_factory_facts f USING(preparation_id)
          WHERE l.module='sourcing' AND l.child_id=NEW.sourcing_case_id AND f.kind='仓库实际发厂'
            AND f.actor_id=event.actor_id AND f.occurred_at=NEW.dispatched_at
            AND f.payload->>'supplierId'=NEW.supplier_id::text
        )) ELSE (event.actor_roles @> ARRAY['root_superuser']::text[] OR
        (event.actor_roles @> ARRAY['order_merchandiser']::text[] AND event.actor_id=source_case.created_by)) END)
      AND event.after_state->>'contractDocumentId'=NEW.sourcing_contract_document_id::text
  ) THEN RAISE EXCEPTION 'dispatch requires current approved ready contract and authorized audit' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END;
$$;
