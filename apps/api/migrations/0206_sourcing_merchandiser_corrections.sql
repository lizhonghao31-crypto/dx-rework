-- Append-only corrections before approval. Original creation and approval facts stay immutable.
CREATE TABLE sourcing_case_corrections (
 correction_id uuid PRIMARY KEY,
 sourcing_case_id uuid NOT NULL REFERENCES sourcing_cases(sourcing_case_id),
 correction_version integer NOT NULL CHECK(correction_version>0),
 gender text NOT NULL CHECK(gender IN ('男装','女装')),
 style_id uuid NOT NULL REFERENCES sourcing_style_catalog(style_id),
 style_name_snapshot text NOT NULL CHECK(length(btrim(style_name_snapshot)) BETWEEN 1 AND 100),
 estimated_cut_piece_send_date date NOT NULL,
 delivery_date date NOT NULL,
 order_quantity integer NOT NULL CHECK(order_quantity BETWEEN 1 AND 10000000),
 lines jsonb NOT NULL CHECK(jsonb_typeof(lines)='array' AND jsonb_array_length(lines) BETWEEN 1 AND 20),
 attachment_ids uuid[] NOT NULL CHECK(cardinality(attachment_ids) BETWEEN 1 AND 20),
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 500),
 corrected_by uuid NOT NULL REFERENCES app_users(id),
 operation_event_id uuid NOT NULL UNIQUE REFERENCES operation_events(event_id),
 request_id text NOT NULL,
 corrected_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(sourcing_case_id,correction_version),
 CHECK(estimated_cut_piece_send_date<=delivery_date)
);
CREATE FUNCTION sourcing_case_facts_at(case_id uuid, at_time timestamptz DEFAULT NULL)
RETURNS SETOF sourcing_cases LANGUAGE sql STABLE AS $$
 SELECT (jsonb_populate_record(c,CASE WHEN v.correction_id IS NULL THEN '{}'::jsonb ELSE
 jsonb_build_object('style_id',v.style_id,'gender',v.gender,'style_name_snapshot',v.style_name_snapshot,
 'estimated_cut_piece_send_date',v.estimated_cut_piece_send_date,'delivery_date',v.delivery_date,
 'order_quantity',v.order_quantity) END)).*
 FROM sourcing_cases c LEFT JOIN LATERAL(SELECT * FROM sourcing_case_corrections v
 WHERE v.sourcing_case_id=c.sourcing_case_id AND (at_time IS NULL OR v.corrected_at<=at_time)
 ORDER BY correction_version DESC LIMIT 1) v ON true WHERE c.sourcing_case_id=case_id
$$;
CREATE FUNCTION sourcing_case_lines_at(case_id uuid, at_time timestamptz DEFAULT NULL)
RETURNS SETOF sourcing_case_lines LANGUAGE sql STABLE AS $$
 WITH revision AS (SELECT * FROM sourcing_case_corrections v WHERE v.sourcing_case_id=case_id
 AND (at_time IS NULL OR v.corrected_at<=at_time) ORDER BY correction_version DESC LIMIT 1)
 SELECT original.* FROM sourcing_case_lines original WHERE original.sourcing_case_id=case_id
 AND NOT EXISTS(SELECT 1 FROM revision)
 UNION ALL
 SELECT (jsonb_populate_record(NULL::sourcing_case_lines,jsonb_build_object(
 'sourcing_case_id',case_id,'position',entry.ordinality,'style_no',entry.value->>'styleNo',
 'alternate_style_no',entry.value->>'alternateStyleNo','color',entry.value->>'color',
 'quantity',(entry.value->>'quantity')::integer,'external_unit_price',NULL,'legacy_source',false,
 'created_by',v.corrected_by,'operation_event_id',v.operation_event_id,'request_id',v.request_id,
 'created_at',v.corrected_at,'image_attachment_id',entry.value->>'imageAttachmentId'))).*
 FROM revision v CROSS JOIN LATERAL jsonb_array_elements(v.lines) WITH ORDINALITY entry(value,ordinality)
$$;
CREATE OR REPLACE VIEW current_sourcing_case_lines AS
SELECT line.sourcing_case_id,line.position,
  COALESCE(identity.style_no,identity.alternate_style_no) AS style_no,
  identity.style_no AS formal_style_no,identity.alternate_style_no,
  line.color,line.quantity,line.external_unit_price,line.legacy_source,line.image_attachment_id
FROM sourcing_cases c CROSS JOIN LATERAL sourcing_case_lines_at(c.sourcing_case_id) line
LEFT JOIN LATERAL (SELECT revision,lines FROM sourcing_style_revisions
  WHERE sourcing_case_id=line.sourcing_case_id ORDER BY revision DESC LIMIT 1) latest ON true
LEFT JOIN LATERAL (SELECT value FROM jsonb_array_elements(latest.lines)
  WHERE (value->>'position')::integer=line.position) revised ON true
CROSS JOIN LATERAL (SELECT
  CASE WHEN latest.revision IS NULL THEN line.style_no ELSE revised.value->>'styleNo' END AS style_no,
  CASE WHEN latest.revision IS NULL THEN line.alternate_style_no ELSE revised.value->>'alternateStyleNo' END AS alternate_style_no
) identity;
CREATE OR REPLACE VIEW current_sourcing_cases AS
SELECT source.sourcing_case_id,source.erp_order_id,source.erp_order_no,
  COALESCE((SELECT style_no FROM current_sourcing_case_lines WHERE sourcing_case_id=source.sourcing_case_id ORDER BY position LIMIT 1),source.style_no) AS style_no,
  source.lane_key,source.order_quantity,transition.to_status AS status,transition.sequence AS version,
  source.created_by,source.created_at,
  greatest(transition.transitioned_at,(SELECT max(created_at) FROM sourcing_style_revisions WHERE sourcing_case_id=source.sourcing_case_id)) AS updated_at,
  source.delivery_date,source.process_description,source.process_items
FROM sourcing_cases original CROSS JOIN LATERAL sourcing_case_facts_at(original.sourcing_case_id) source
JOIN LATERAL(SELECT to_status,sequence,transitioned_at FROM sourcing_case_transitions
  WHERE sourcing_case_id=source.sourcing_case_id ORDER BY sequence DESC LIMIT 1) transition ON true
WHERE source.deleted_at IS NULL;
CREATE OR REPLACE VIEW sourcing_style_aliases AS
 SELECT sourcing_case_id,position,style_no FROM sourcing_case_lines WHERE style_no IS NOT NULL
 UNION SELECT sourcing_case_id,position,alternate_style_no FROM sourcing_case_lines WHERE alternate_style_no IS NOT NULL
 UNION SELECT sourcing_case_id,(entry->>'position')::integer,entry->>'styleNo' FROM sourcing_style_revisions,jsonb_array_elements(lines) entry WHERE entry->>'styleNo' IS NOT NULL
 UNION SELECT sourcing_case_id,(entry->>'position')::integer,entry->>'alternateStyleNo' FROM sourcing_style_revisions,jsonb_array_elements(lines) entry WHERE entry->>'alternateStyleNo' IS NOT NULL
 UNION SELECT sourcing_case_id,entry.ordinality::integer,entry.value->>'styleNo' FROM sourcing_case_corrections,jsonb_array_elements(lines) WITH ORDINALITY entry(value,ordinality) WHERE entry.value->>'styleNo' IS NOT NULL
 UNION SELECT sourcing_case_id,entry.ordinality::integer,entry.value->>'alternateStyleNo' FROM sourcing_case_corrections,jsonb_array_elements(lines) WITH ORDINALITY entry(value,ordinality) WHERE entry.value->>'alternateStyleNo' IS NOT NULL;

-- Extend only the existing transition constraints; all other states/actions remain unchanged.
DO $$ DECLARE c record; BEGIN
 FOR c IN SELECT conname,pg_get_constraintdef(oid) definition FROM pg_constraint
 WHERE conrelid='sourcing_case_transitions'::regclass AND contype='c'
 AND (pg_get_constraintdef(oid) LIKE '%to_status%' OR pg_get_constraintdef(oid) LIKE '%from_status%' OR pg_get_constraintdef(oid) LIKE '%business_action%') LOOP
 EXECUTE format('ALTER TABLE sourcing_case_transitions DROP CONSTRAINT %I',c.conname);
 IF c.definition LIKE '%business_action%' THEN
 c.definition:=replace(c.definition,'''created''::text','''created''::text, ''returned_to_merchandiser''::text, ''correction_submitted''::text');
 ELSE c.definition:=replace(c.definition,'''pending_ie_quote''::text','''pending_ie_quote''::text, ''pending_merchandiser_correction''::text'); END IF;
 EXECUTE format('ALTER TABLE sourcing_case_transitions ADD CONSTRAINT %I %s',c.conname,c.definition);
 END LOOP;
END $$;
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
CREATE OR REPLACE FUNCTION guard_sourcing_ie_quote_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  source_case sourcing_cases%ROWTYPE;
  previous_version integer;
BEGIN
  PERFORM 1 FROM sourcing_cases WHERE sourcing_case_id=NEW.sourcing_case_id FOR UPDATE;
  SELECT * INTO source_case FROM sourcing_case_facts_at(NEW.sourcing_case_id);
  SELECT COALESCE(max(quote_version),0) INTO previous_version
  FROM sourcing_ie_quotes WHERE sourcing_case_id=NEW.sourcing_case_id;
  IF source_case.sourcing_case_id IS NULL
    OR sourcing_current_status(NEW.sourcing_case_id)<>'pending_ie_quote'
    OR NEW.quote_version<>previous_version+1
    OR NEW.quantity<>source_case.order_quantity THEN
    RAISE EXCEPTION 'IE quote must price the immutable order quantity in pending IE quote state'
      USING ERRCODE='23514';
  END IF;
  PERFORM sourcing_require_operation_event(
    NEW.operation_event_id,NEW.request_id,NEW.quoted_by,
    'sourcing.ie_price.quote','sourcing:price:quote',
    NEW.sourcing_case_id,NEW.quote_reason
  );
  RETURN NEW;
END;
$$;
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
CREATE FUNCTION guard_sourcing_case_correction() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source sourcing_cases%ROWTYPE; e operation_events%ROWTYPE;
BEGIN
 SELECT * INTO source FROM sourcing_cases WHERE sourcing_case_id=NEW.sourcing_case_id FOR UPDATE;
 SELECT * INTO e FROM operation_events WHERE event_id=NEW.operation_event_id;
 IF source.deleted_at IS NOT NULL OR sourcing_current_status(NEW.sourcing_case_id)<>'pending_merchandiser_correction'
 OR EXISTS(SELECT 1 FROM sourcing_approval_snapshots WHERE sourcing_case_id=NEW.sourcing_case_id)
 OR NEW.correction_version<>(SELECT count(*)+1 FROM sourcing_case_corrections WHERE sourcing_case_id=NEW.sourcing_case_id)
 OR NEW.order_quantity<>(SELECT sum((value->>'quantity')::integer) FROM jsonb_array_elements(NEW.lines))
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.lines) line WHERE (line->>'quantity')::integer IS NULL OR (line->>'quantity')::integer<1 OR NULLIF(btrim(line->>'color'),'') IS NULL OR (NULLIF(btrim(line->>'styleNo'),'') IS NULL AND NULLIF(btrim(line->>'alternateStyleNo'),'') IS NULL))
 OR e.after_state->>'gender' IS DISTINCT FROM NEW.gender
 OR e.after_state->>'styleName' IS DISTINCT FROM NEW.style_name_snapshot
 OR e.after_state->'attachmentIds' IS DISTINCT FROM to_jsonb(NEW.attachment_ids)
 OR NOT EXISTS(SELECT 1 FROM sourcing_style_catalog WHERE style_id=NEW.style_id AND normalized_name=lower(btrim(NEW.style_name_snapshot)))
 OR e.actor_id IS DISTINCT FROM NEW.corrected_by
 OR NOT(e.actor_roles @> ARRAY['root_superuser']::text[] OR (e.actor_roles @> ARRAY['order_merchandiser']::text[] AND source.created_by=NEW.corrected_by))
 OR e.after_state->'lineItems' IS DISTINCT FROM NEW.lines
 OR e.after_state->>'deliveryDate' IS DISTINCT FROM NEW.delivery_date::text
 OR e.after_state->>'estimatedCutPieceSendDate' IS DISTINCT FROM NEW.estimated_cut_piece_send_date::text
 THEN RAISE EXCEPTION 'invalid sourcing correction fact' USING ERRCODE='55000'; END IF;
 PERFORM sourcing_require_operation_event(NEW.operation_event_id,NEW.request_id,NEW.corrected_by,
 'sourcing.case.correct','sourcing:inquiry:create',NEW.sourcing_case_id,NEW.reason);
 RETURN NEW;
END $$;
CREATE TRIGGER sourcing_case_corrections_guard BEFORE INSERT ON sourcing_case_corrections
 FOR EACH ROW EXECUTE FUNCTION guard_sourcing_case_correction();
CREATE TRIGGER sourcing_case_corrections_immutable BEFORE UPDATE OR DELETE ON sourcing_case_corrections
 FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER sourcing_case_corrections_no_truncate BEFORE TRUNCATE ON sourcing_case_corrections
 FOR EACH STATEMENT EXECUTE FUNCTION reject_operation_event_mutation();

-- Existing bad dates stay visible for correction; never rewrite production facts in a migration.
CREATE FUNCTION guard_sourcing_dates() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source sourcing_cases%ROWTYPE;
BEGIN
 IF TG_TABLE_NAME='sourcing_cases' THEN source:=NEW;
 ELSE SELECT * INTO source FROM sourcing_case_facts_at(NEW.sourcing_case_id); END IF;
 IF source.estimated_cut_piece_send_date>source.delivery_date THEN
 RAISE EXCEPTION '预计裁片发出日期不能晚于要求交货日期' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER sourcing_dates_create BEFORE INSERT ON sourcing_cases FOR EACH ROW EXECUTE FUNCTION guard_sourcing_dates();
CREATE TRIGGER sourcing_dates_quote BEFORE INSERT ON sourcing_ie_quotes FOR EACH ROW EXECUTE FUNCTION guard_sourcing_dates();
CREATE TRIGGER sourcing_dates_management BEFORE INSERT ON sourcing_decisions FOR EACH ROW EXECUTE FUNCTION guard_sourcing_dates();
CREATE FUNCTION guard_sourcing_approval_dates() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source sourcing_cases%ROWTYPE;
BEGIN
 IF NEW.decision='approved' THEN
 SELECT * INTO source FROM sourcing_case_facts_at(NEW.sourcing_case_id);
 IF source.estimated_cut_piece_send_date>source.delivery_date THEN
 RAISE EXCEPTION '预计裁片发出日期不能晚于要求交货日期' USING ERRCODE='23514'; END IF;
 END IF; RETURN NEW;
END $$;
CREATE TRIGGER sourcing_dates_owner BEFORE INSERT ON sourcing_owner_decisions FOR EACH ROW EXECUTE FUNCTION guard_sourcing_approval_dates();
