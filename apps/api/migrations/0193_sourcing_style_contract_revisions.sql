-- Style labels may arrive after quantities/prices. Original facts remain immutable.
ALTER TABLE sourcing_case_lines ALTER COLUMN style_no DROP NOT NULL;
ALTER TABLE sourcing_case_lines ADD CONSTRAINT sourcing_case_lines_identity_required
  CHECK(style_no IS NOT NULL OR alternate_style_no IS NOT NULL);

CREATE TABLE sourcing_style_revisions (
  sourcing_case_id uuid NOT NULL REFERENCES sourcing_cases(sourcing_case_id),
  revision integer NOT NULL CHECK(revision>0),
  lines jsonb NOT NULL CHECK(jsonb_typeof(lines)='array'),
  changed_by uuid NOT NULL REFERENCES app_users(id),
  operation_event_id uuid NOT NULL UNIQUE REFERENCES operation_events(event_id),
  request_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(sourcing_case_id,revision)
);
CREATE FUNCTION guard_sourcing_style_revision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source sourcing_cases%ROWTYPE; event operation_events%ROWTYPE; entry jsonb;
BEGIN
  SELECT * INTO source FROM sourcing_cases WHERE sourcing_case_id=NEW.sourcing_case_id FOR UPDATE;
  SELECT * INTO event FROM operation_events WHERE event_id=NEW.operation_event_id;
  IF source.sourcing_case_id IS NULL OR source.deleted_at IS NOT NULL
    OR NEW.revision<>(SELECT COALESCE(max(revision),0)+1 FROM sourcing_style_revisions WHERE sourcing_case_id=NEW.sourcing_case_id)
    OR event.event_id IS NULL OR event.action<>'sourcing.styles.revise'
    OR event.entity_type<>'sourcing_case' OR event.entity_id<>NEW.sourcing_case_id::text
    OR event.actor_id<>NEW.changed_by OR event.request_id<>NEW.request_id
    OR event.after_state->'lines' IS DISTINCT FROM NEW.lines
    OR NOT (event.actor_roles @> ARRAY['root_superuser']::text[]
      OR (event.actor_roles @> ARRAY['production_management']::text[] AND event.authorization_capability='sourcing:decision:record')
      OR (event.actor_roles @> ARRAY['order_merchandiser']::text[] AND event.actor_id=source.created_by
        AND event.authorization_capability='sourcing:inquiry:create'))
  THEN RAISE EXCEPTION 'style revision requires current version and authorized audit' USING ERRCODE='55000'; END IF;
  IF jsonb_array_length(NEW.lines)<>(SELECT count(*) FROM sourcing_case_lines WHERE sourcing_case_id=NEW.sourcing_case_id)
    OR (SELECT count(DISTINCT value->>'position') FROM jsonb_array_elements(NEW.lines))<>jsonb_array_length(NEW.lines)
  THEN RAISE EXCEPTION 'style revision must cover exactly the existing lines' USING ERRCODE='55000'; END IF;
  FOR entry IN SELECT value FROM jsonb_array_elements(NEW.lines) LOOP
    IF jsonb_typeof(entry)<>'object' OR entry-ARRAY['position','styleNo','alternateStyleNo']<>'{}'::jsonb
      OR NOT EXISTS(SELECT 1 FROM sourcing_case_lines WHERE sourcing_case_id=NEW.sourcing_case_id AND position=(entry->>'position')::integer)
      OR (nullif(btrim(entry->>'styleNo'),'') IS NULL AND nullif(btrim(entry->>'alternateStyleNo'),'') IS NULL)
      OR (entry->>'styleNo' IS NOT NULL AND length(btrim(entry->>'styleNo')) NOT BETWEEN 1 AND 100)
      OR (entry->>'alternateStyleNo' IS NOT NULL AND length(btrim(entry->>'alternateStyleNo')) NOT BETWEEN 1 AND 100)
    THEN RAISE EXCEPTION 'invalid style revision line' USING ERRCODE='55000'; END IF;
  END LOOP;
  RETURN NEW;
END; $$;
CREATE TRIGGER sourcing_style_revision_guard BEFORE INSERT ON sourcing_style_revisions
  FOR EACH ROW EXECUTE FUNCTION guard_sourcing_style_revision();
CREATE TRIGGER sourcing_style_revision_immutable BEFORE UPDATE OR DELETE ON sourcing_style_revisions
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER sourcing_style_revision_no_truncate BEFORE TRUNCATE ON sourcing_style_revisions
  FOR EACH STATEMENT EXECUTE FUNCTION reject_operation_event_mutation();

CREATE VIEW current_sourcing_case_lines AS
SELECT line.sourcing_case_id,line.position,
  COALESCE(identity.style_no,identity.alternate_style_no) AS style_no,
  identity.style_no AS formal_style_no,identity.alternate_style_no,
  line.color,line.quantity,line.external_unit_price,line.legacy_source
FROM sourcing_case_lines line
LEFT JOIN LATERAL (SELECT revision,lines FROM sourcing_style_revisions
  WHERE sourcing_case_id=line.sourcing_case_id ORDER BY revision DESC LIMIT 1) latest ON true
LEFT JOIN LATERAL (SELECT value FROM jsonb_array_elements(latest.lines)
  WHERE (value->>'position')::integer=line.position) revised ON true
CROSS JOIN LATERAL (SELECT
  CASE WHEN latest.revision IS NULL THEN line.style_no ELSE revised.value->>'styleNo' END AS style_no,
  CASE WHEN latest.revision IS NULL THEN line.alternate_style_no ELSE revised.value->>'alternateStyleNo' END AS alternate_style_no
) identity;

CREATE VIEW sourcing_style_aliases AS
SELECT sourcing_case_id,position,style_no AS style_no FROM sourcing_case_lines WHERE style_no IS NOT NULL
UNION SELECT sourcing_case_id,position,alternate_style_no FROM sourcing_case_lines WHERE alternate_style_no IS NOT NULL
UNION SELECT sourcing_case_id,(entry->>'position')::integer,entry->>'styleNo'
  FROM sourcing_style_revisions,jsonb_array_elements(lines) entry WHERE entry->>'styleNo' IS NOT NULL
UNION SELECT sourcing_case_id,(entry->>'position')::integer,entry->>'alternateStyleNo'
  FROM sourcing_style_revisions,jsonb_array_elements(lines) entry WHERE entry->>'alternateStyleNo' IS NOT NULL;

CREATE OR REPLACE VIEW current_sourcing_cases AS
SELECT source.sourcing_case_id,source.erp_order_id,source.erp_order_no,
  COALESCE((SELECT style_no FROM current_sourcing_case_lines WHERE sourcing_case_id=source.sourcing_case_id ORDER BY position LIMIT 1),source.style_no) AS style_no,
  source.lane_key,source.order_quantity,transition.to_status AS status,transition.sequence AS version,
  source.created_by,source.created_at,
  greatest(transition.transitioned_at,(SELECT max(created_at) FROM sourcing_style_revisions WHERE sourcing_case_id=source.sourcing_case_id)) AS updated_at,
  source.delivery_date,source.process_description,source.process_items
FROM sourcing_cases source
JOIN LATERAL(SELECT to_status,sequence,transitioned_at FROM sourcing_case_transitions
  WHERE sourcing_case_id=source.sourcing_case_id ORDER BY sequence DESC LIMIT 1) transition ON true
WHERE source.deleted_at IS NULL;

CREATE FUNCTION sourcing_current_first_style(case_id uuid) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT style_no FROM current_sourcing_case_lines WHERE sourcing_case_id=case_id ORDER BY position LIMIT 1
$$;

-- Contract versions are independent of price approvals; each revision gets a new PDF.
ALTER TABLE sourcing_contract_documents
  DROP CONSTRAINT sourcing_contract_documents_sourcing_approval_snapshot_id_key,
  ADD COLUMN identity_version integer NOT NULL DEFAULT 0 CHECK(identity_version>=0),
  ADD COLUMN revision_of uuid REFERENCES sourcing_contract_documents(sourcing_contract_document_id),
  ADD CONSTRAINT sourcing_contract_revision_unique UNIQUE(sourcing_approval_snapshot_id,identity_version,template_version);
CREATE FUNCTION guard_sourcing_contract_revision_metadata() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.identity_version<>OLD.identity_version OR NEW.revision_of IS DISTINCT FROM OLD.revision_of THEN
    RAISE EXCEPTION 'contract revision metadata is immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER sourcing_contract_revision_metadata BEFORE UPDATE ON sourcing_contract_documents
  FOR EACH ROW EXECUTE FUNCTION guard_sourcing_contract_revision_metadata();

CREATE FUNCTION guard_sourcing_current_contract() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM sourcing_cases WHERE sourcing_case_id=NEW.sourcing_case_id FOR UPDATE;
  IF NEW.sourcing_contract_document_id IS DISTINCT FROM (
    SELECT sourcing_contract_document_id FROM sourcing_contract_documents
    WHERE sourcing_case_id=NEW.sourcing_case_id ORDER BY contract_version DESC LIMIT 1
  ) THEN RAISE EXCEPTION 'operation requires latest contract revision' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER sourcing_finance_current_contract BEFORE INSERT ON sourcing_finance_reconciliations
  FOR EACH ROW EXECUTE FUNCTION guard_sourcing_current_contract();
CREATE TRIGGER sourcing_dispatch_current_contract BEFORE INSERT ON sourcing_production_orders
  FOR EACH ROW EXECUTE FUNCTION guard_sourcing_current_contract();

-- Historical labels remain valid for matching paperwork issued before a correction.
CREATE OR REPLACE FUNCTION guard_sourcing_production_receipt_link() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM receiving_receipts receipt
  JOIN sourcing_production_shipments shipment ON shipment.production_order_id=NEW.production_order_id
  JOIN sourcing_production_orders production USING(production_order_id)
  JOIN operation_events event ON event.event_id=NEW.operation_event_id
  WHERE receipt.receipt_id=NEW.receipt_id AND receipt.operation_event_id=NEW.operation_event_id
   AND EXISTS(SELECT 1 FROM sourcing_style_aliases alias WHERE alias.sourcing_case_id=production.sourcing_case_id
     AND alias.position=1 AND upper(btrim(alias.style_no))=upper(btrim(receipt.style_no)))
   AND (receipt.received_at AT TIME ZONE 'Asia/Shanghai')::date>=shipment.shipped_on
   AND event.action='receiving.receipt.create' AND event.entity_id=NEW.receipt_id::text
   AND event.after_state->>'productionOrderId'=NEW.production_order_id::text)
 THEN RAISE EXCEPTION 'receipt link must match shipped first style and actual receipt audit' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END; $$;

CREATE OR REPLACE FUNCTION guard_sourcing_production_shipment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM sourcing_production_orders production JOIN sourcing_production_transitions transition USING(production_order_id)
   JOIN operation_events event ON event.event_id=NEW.operation_event_id
   WHERE production.production_order_id=NEW.production_order_id
     AND EXISTS(SELECT 1 FROM sourcing_style_aliases alias WHERE alias.sourcing_case_id=production.sourcing_case_id AND alias.position=1 AND alias.style_no=NEW.first_style_no)
     AND event.after_state->>'firstStyleNo'=NEW.first_style_no
     AND transition.status='shipped' AND transition.business_date=NEW.shipped_on AND transition.actor_id=NEW.actor_id
     AND transition.operation_event_id=NEW.operation_event_id)
   OR NEW.recorded_quantity<>(SELECT COALESCE(sum(quantity),0) FROM effective_sourcing_production_reports WHERE production_order_id=NEW.production_order_id)
 THEN RAISE EXCEPTION 'shipment must match production shipping transition' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END; $$;
