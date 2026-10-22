-- No historical backfill: new business facts enroll after this policy is installed.
CREATE TABLE sourcing_contract_return_cycle_policy (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  enabled_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO sourcing_contract_return_cycle_policy(singleton) VALUES(true);
CREATE TABLE sourcing_contract_return_cycles (
  sourcing_approval_snapshot_id uuid PRIMARY KEY REFERENCES sourcing_approval_snapshots(sourcing_approval_snapshot_id),
  sourcing_case_id uuid NOT NULL REFERENCES sourcing_cases(sourcing_case_id),
  business_event_id uuid NOT NULL UNIQUE REFERENCES operation_events(event_id),
  origin text NOT NULL CHECK(origin IN ('business','historical')),
  created_operation_event_id uuid NOT NULL REFERENCES operation_events(event_id),
  first_document_id uuid UNIQUE REFERENCES sourcing_contract_documents(sourcing_contract_document_id),
  generated_at timestamptz,
  due_at timestamptz,
  CHECK ((first_document_id IS NULL AND generated_at IS NULL AND due_at IS NULL)
    OR (first_document_id IS NOT NULL AND generated_at IS NOT NULL AND due_at=sourcing_contract_return_add_hours(generated_at,48)))
);
CREATE INDEX sourcing_contract_return_cycles_case_idx ON sourcing_contract_return_cycles(sourcing_case_id);

CREATE FUNCTION guard_sourcing_contract_return_cycle() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE snapshot sourcing_approval_snapshots%ROWTYPE; business operation_events%ROWTYPE;
  audit operation_events%ROWTYPE; document sourcing_contract_documents%ROWTYPE;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'contract return cycle evidence cannot be deleted' USING ERRCODE='55000'; END IF;
  IF TG_OP='UPDATE' THEN
    IF (NEW.sourcing_approval_snapshot_id,NEW.sourcing_case_id,NEW.business_event_id,NEW.origin,NEW.created_operation_event_id)
      IS DISTINCT FROM (OLD.sourcing_approval_snapshot_id,OLD.sourcing_case_id,OLD.business_event_id,OLD.origin,OLD.created_operation_event_id)
      OR OLD.first_document_id IS NOT NULL THEN
      RAISE EXCEPTION 'contract return cycle basis and first ready time are immutable' USING ERRCODE='55000';
    END IF;
  END IF;
  SELECT * INTO snapshot FROM sourcing_approval_snapshots WHERE sourcing_approval_snapshot_id=NEW.sourcing_approval_snapshot_id;
  SELECT * INTO business FROM operation_events WHERE event_id=NEW.business_event_id;
  SELECT * INTO audit FROM operation_events WHERE event_id=NEW.created_operation_event_id;
  IF snapshot.sourcing_case_id IS DISTINCT FROM NEW.sourcing_case_id OR snapshot.operation_event_id IS DISTINCT FROM business.event_id
    OR NOT (business.action IN ('sourcing.factory_change.effective','sourcing.price_reapplication.effective')
      OR business.action='sourcing.owner.approve' AND EXISTS(SELECT 1 FROM sourcing_decisions decision
        WHERE decision.sourcing_decision_id=snapshot.sourcing_decision_id AND decision.source_change_request_id IS NOT NULL)) THEN
    RAISE EXCEPTION 'contract return cycle requires an effective re-signing business action' USING ERRCODE='42501';
  END IF;
  IF NEW.origin='business' THEN
    IF business.created_at<(SELECT enabled_at FROM sourcing_contract_return_cycle_policy WHERE singleton)
      OR NEW.created_operation_event_id<>business.event_id THEN
      RAISE EXCEPTION 'historical business events cannot activate new return rules' USING ERRCODE='42501';
    END IF;
  ELSE
    IF audit.action<>'sourcing.contract_return_cycle.reconcile' OR NOT audit.actor_roles @> ARRAY['root_superuser']::text[]
      OR audit.entity_id<>NEW.sourcing_case_id::text OR NOT EXISTS (
        SELECT 1 FROM (VALUES
          ('46983c93-bb0c-4a28-b23c-4531feb4ad41'::uuid,'14cdb30d-d148-4cd7-a9ac-6b65be5f61d0'::uuid,2,'2026-10-15T11:40:54+08:00'::timestamptz),
          ('cb942dbe-d6b2-43b2-9f48-3933566b7cf0'::uuid,'1e4c3ec5-d2ec-4404-aa7f-fef33262ac3c'::uuid,3,'2026-10-13T18:15:39+08:00'::timestamptz),
          ('edfb86e9-9206-419d-8faf-ca11cb7c88ac'::uuid,'aff97855-53bc-4692-9c9b-b925fa80ebff'::uuid,3,'2026-09-30T08:59:13+08:00'::timestamptz)
        ) allowed(case_id,document_id,version,ready_at)
        JOIN sourcing_contract_documents d ON d.sourcing_contract_document_id=allowed.document_id
          AND d.sourcing_case_id=allowed.case_id AND d.contract_version=allowed.version
          AND date_trunc('second',d.generated_at)=allowed.ready_at
        WHERE NEW.sourcing_case_id=allowed.case_id AND NEW.first_document_id=d.sourcing_contract_document_id
          AND d.sourcing_approval_snapshot_id=NEW.sourcing_approval_snapshot_id
          AND d.status='ready' AND d.pdf_attachment_id IS NOT NULL
          AND NOT EXISTS(SELECT 1 FROM sourcing_contract_documents newer WHERE newer.sourcing_case_id=d.sourcing_case_id AND newer.contract_version>d.contract_version)
      ) THEN RAISE EXCEPTION 'historical return cycle is outside the three exact approved baselines' USING ERRCODE='42501'; END IF;
  END IF;
  IF NEW.first_document_id IS NOT NULL THEN
    SELECT * INTO document FROM sourcing_contract_documents WHERE sourcing_contract_document_id=NEW.first_document_id;
    IF document.sourcing_approval_snapshot_id IS DISTINCT FROM NEW.sourcing_approval_snapshot_id
      OR document.status<>'ready' OR document.pdf_attachment_id IS NULL OR document.generated_at IS DISTINCT FROM NEW.generated_at THEN
      RAISE EXCEPTION 'cycle start must match the real first ready contract evidence' USING ERRCODE='42501';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sourcing_contract_return_cycle_guard BEFORE INSERT OR UPDATE OR DELETE ON sourcing_contract_return_cycles
  FOR EACH ROW EXECUTE FUNCTION guard_sourcing_contract_return_cycle();

CREATE FUNCTION enroll_sourcing_contract_return_cycle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO sourcing_contract_return_cycles(sourcing_approval_snapshot_id,sourcing_case_id,business_event_id,origin,created_operation_event_id)
  SELECT NEW.sourcing_approval_snapshot_id,NEW.sourcing_case_id,event.event_id,'business',event.event_id FROM operation_events event
  WHERE event.event_id=NEW.operation_event_id AND (event.action IN ('sourcing.factory_change.effective','sourcing.price_reapplication.effective')
    OR event.action='sourcing.owner.approve' AND EXISTS(SELECT 1 FROM sourcing_decisions decision
      WHERE decision.sourcing_decision_id=NEW.sourcing_decision_id AND decision.source_change_request_id IS NOT NULL))
    AND event.created_at>=(SELECT enabled_at FROM sourcing_contract_return_cycle_policy WHERE singleton)
  ON CONFLICT(sourcing_approval_snapshot_id) DO NOTHING;
  RETURN NEW;
END $$;
CREATE TRIGGER sourcing_approval_return_cycle AFTER INSERT ON sourcing_approval_snapshots
  FOR EACH ROW EXECUTE FUNCTION enroll_sourcing_contract_return_cycle();
CREATE FUNCTION start_sourcing_version_return_clock() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status='ready' AND NEW.pdf_attachment_id IS NOT NULL AND NEW.generated_at IS NOT NULL THEN
    UPDATE sourcing_contract_return_cycles SET first_document_id=NEW.sourcing_contract_document_id,
      generated_at=NEW.generated_at,due_at=sourcing_contract_return_add_hours(NEW.generated_at,48)
    WHERE sourcing_approval_snapshot_id=NEW.sourcing_approval_snapshot_id AND generated_at IS NULL;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sourcing_version_return_ready AFTER UPDATE OF status ON sourcing_contract_documents
  FOR EACH ROW EXECUTE FUNCTION start_sourcing_version_return_clock();

-- One read contract for lists, filters and details; absent cycles preserve the complete legacy path.
CREATE FUNCTION sourcing_contract_return_facts(case_id uuid)
RETURNS TABLE(sourcing_case_id uuid,contract_return_monitor_enabled boolean,contract_return_catchup boolean,
  contract_generated_at timestamptz,contract_return_due_at timestamptz,contract_returned_at timestamptz,
  contract_return_uploaded_by uuid,contract_return_latest_uploaded_by uuid,return_cycle_id uuid)
LANGUAGE sql STABLE AS $$
  SELECT source.sourcing_case_id,
    CASE WHEN cycle.sourcing_approval_snapshot_id IS NOT NULL THEN true ELSE COALESCE(legacy.contract_return_monitor_enabled,false) END,
    COALESCE(legacy.contract_return_catchup,false),
    CASE WHEN cycle.sourcing_approval_snapshot_id IS NOT NULL THEN cycle.generated_at ELSE legacy.contract_generated_at END,
    CASE WHEN cycle.sourcing_approval_snapshot_id IS NOT NULL THEN cycle.due_at ELSE legacy.contract_return_due_at END,
    CASE WHEN cycle.sourcing_approval_snapshot_id IS NOT NULL THEN signed.submitted_at ELSE legacy.contract_returned_at END,
    CASE WHEN cycle.sourcing_approval_snapshot_id IS NOT NULL THEN signed.submitted_by ELSE legacy.contract_return_uploaded_by END,
    CASE WHEN cycle.sourcing_approval_snapshot_id IS NOT NULL THEN signed.submitted_by ELSE legacy.contract_return_latest_uploaded_by END,
    cycle.sourcing_approval_snapshot_id
  FROM sourcing_cases source
  LEFT JOIN sourcing_contract_return_monitors legacy ON legacy.sourcing_case_id=source.sourcing_case_id
  LEFT JOIN LATERAL (SELECT d.sourcing_approval_snapshot_id FROM sourcing_contract_documents d
    WHERE d.sourcing_case_id=source.sourcing_case_id ORDER BY d.contract_version DESC LIMIT 1) current_document ON true
  LEFT JOIN sourcing_contract_return_cycles cycle ON cycle.sourcing_approval_snapshot_id=current_document.sourcing_approval_snapshot_id
  LEFT JOIN LATERAL (SELECT submission.submitted_at,submission.submitted_by
    FROM sourcing_contract_return_submissions submission
    JOIN sourcing_contract_documents d ON d.sourcing_contract_document_id=submission.sourcing_contract_document_id
    WHERE d.sourcing_approval_snapshot_id=cycle.sourcing_approval_snapshot_id
      AND EXISTS(SELECT 1 FROM sourcing_contract_return_attachments link JOIN attachments file USING(attachment_id)
        WHERE link.submission_id=submission.submission_id AND file.status='ready')
    ORDER BY submission.submitted_at,submission.revision LIMIT 1) signed ON true
  WHERE source.sourcing_case_id=case_id
$$;
