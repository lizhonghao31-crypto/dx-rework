-- SSP-05: immutable contract preparation, generated PDF evidence and finance binding.

CREATE SEQUENCE sourcing_contract_number_seq;

CREATE TABLE sourcing_contract_template_versions (
  template_version integer PRIMARY KEY CHECK(template_version > 0),
  template_name text NOT NULL CHECK(length(btrim(template_name)) BETWEEN 1 AND 100),
  party_a_name text NOT NULL CHECK(length(btrim(party_a_name)) BETWEEN 1 AND 200),
  signing_place text NOT NULL CHECK(length(btrim(signing_place)) BETWEEN 1 AND 200),
  terms jsonb NOT NULL CHECK(jsonb_typeof(terms)='object'),
  effective_from timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO sourcing_contract_template_versions(
  template_version,template_name,party_a_name,signing_place,terms,effective_from
) VALUES(
  1,'外发服装加工合同 V1','广州达兴服装有限公司','广州',
  jsonb_build_object(
    'processingResponsibility','乙方按本合同款式、数量、工艺和交期完成加工。',
    'qualityRequirements','乙方须按甲方确认的工艺与质量标准交付。',
    'delayPenalty','逾期责任按双方确认的延期事实据实处理。',
    'logistics','裁片发出与成品回货由双方按订单节点交接留痕。',
    'reasonableLoss','合理损耗及超损责任以实际核定记录为准。',
    'defectRate','次品数量与责任以平台验收记录为准。',
    'payment','按平台确认的合格数量、合同单价及财务核对结果结算。',
    'validity','本合同自双方确认之日起生效，履行完毕后终止。'
  ),
  '-infinity'::timestamptz
);

CREATE TABLE sourcing_contract_documents (
  sourcing_contract_document_id uuid PRIMARY KEY,
  sourcing_case_id uuid NOT NULL REFERENCES sourcing_cases(sourcing_case_id),
  sourcing_approval_snapshot_id uuid NOT NULL UNIQUE
    REFERENCES sourcing_approval_snapshots(sourcing_approval_snapshot_id),
  sourcing_decision_id uuid NOT NULL REFERENCES sourcing_decisions(sourcing_decision_id),
  contract_version integer NOT NULL CHECK(contract_version > 0),
  contract_number text NOT NULL UNIQUE
    CHECK(contract_number ~ '^DX-WF-[0-9]{8}-[0-9]{6}$'),
  template_version integer NOT NULL
    REFERENCES sourcing_contract_template_versions(template_version),
  approval_snapshot jsonb NOT NULL CHECK(jsonb_typeof(approval_snapshot)='object'),
  missing_fields text[] NOT NULL DEFAULT '{}'::text[]
    CHECK(missing_fields <@ ARRAY[
      'address','contractEntityName','partyBRepresentative',
      'payeeName','bankAccount','bankName'
    ]::text[] AND array_position(missing_fields,NULL) IS NULL),
  status text NOT NULL CHECK(status IN (
    'pending_supplement','generation_pending','generating','ready','generation_failed'
  )),
  snapshot_fingerprint char(64),
  pdf_attachment_id uuid UNIQUE REFERENCES attachments(attachment_id),
  pdf_sha256 char(64),
  failure_reason text CHECK(failure_reason IS NULL OR length(failure_reason)<=500),
  prepared_by uuid NOT NULL REFERENCES app_users(id),
  prepared_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  generated_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(sourcing_case_id,contract_version),
  CHECK(snapshot_fingerprint IS NULL OR snapshot_fingerprint ~ '^[0-9a-f]{64}$'),
  CHECK(pdf_sha256 IS NULL OR pdf_sha256 ~ '^[0-9a-f]{64}$'),
  CHECK((status='ready')=(pdf_attachment_id IS NOT NULL AND pdf_sha256 IS NOT NULL
    AND snapshot_fingerprint IS NOT NULL AND generated_at IS NOT NULL)),
  CHECK(status<>'pending_supplement' OR cardinality(missing_fields)>0)
);
CREATE INDEX sourcing_contract_documents_case_idx
  ON sourcing_contract_documents(sourcing_case_id,contract_version DESC);

CREATE TABLE sourcing_contract_supplements (
  sourcing_contract_supplement_id uuid PRIMARY KEY,
  sourcing_contract_document_id uuid NOT NULL
    REFERENCES sourcing_contract_documents(sourcing_contract_document_id),
  field_name text NOT NULL CHECK(field_name IN (
    'address','contractEntityName','partyBRepresentative',
    'payeeName','bankAccount','bankName'
  )),
  field_value text NOT NULL CHECK(length(btrim(field_value)) BETWEEN 1 AND 300),
  source_label text NOT NULL DEFAULT '本合同补充资料'
    CHECK(source_label='本合同补充资料'),
  supplemented_by uuid NOT NULL REFERENCES app_users(id),
  operation_event_id uuid NOT NULL UNIQUE REFERENCES operation_events(event_id),
  request_id text NOT NULL CHECK(request_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  supplemented_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(sourcing_contract_document_id,field_name)
);

ALTER TABLE sourcing_finance_reconciliations
  ADD COLUMN sourcing_contract_document_id uuid
    REFERENCES sourcing_contract_documents(sourcing_contract_document_id),
  ADD COLUMN contract_version integer,
  ADD COLUMN contract_fingerprint char(64);

CREATE UNIQUE INDEX sourcing_finance_contract_version_idx
  ON sourcing_finance_reconciliations(
    sourcing_contract_document_id,reconciliation_version
  ) WHERE sourcing_contract_document_id IS NOT NULL;

-- Prepare historical approved decisions without inventing missing supplier facts.
INSERT INTO sourcing_contract_documents(
  sourcing_contract_document_id,sourcing_case_id,sourcing_approval_snapshot_id,
  sourcing_decision_id,contract_version,contract_number,template_version,
  approval_snapshot,missing_fields,status,prepared_by,prepared_at
)
SELECT gen_random_uuid(),snapshot.sourcing_case_id,snapshot.sourcing_approval_snapshot_id,
       snapshot.sourcing_decision_id,snapshot.decision_version,
       'DX-WF-'||to_char(snapshot.approved_at AT TIME ZONE 'Asia/Shanghai','YYYYMMDD')||'-'||
         lpad(nextval('sourcing_contract_number_seq')::text,6,'0'),
       1,
       jsonb_build_object(
         'supplierId',snapshot.supplier_id,
         'supplierCode',snapshot.supplier_code_snapshot,
         'supplierName',snapshot.supplier_name_snapshot,
         'address',snapshot.supplier_address,
         'contractEntityName',snapshot.contract_entity_name,
         'partyBRepresentative',snapshot.party_b_representative,
         'payeeName',snapshot.payee_name,
         'bankAccount',snapshot.bank_account,
         'bankName',snapshot.bank_name,
         'quantity',snapshot.quantity,
         'totalAmount',snapshot.total_amount,
         'estimatedCutPieceSendDate',snapshot.estimated_cut_piece_send_date,
         'deliveryDate',snapshot.delivery_date,
         'processes',snapshot.processes,
         'approvedAt',snapshot.approved_at,
         'lines',COALESCE((
           SELECT jsonb_agg(jsonb_build_object(
             'position',line.position,'styleNo',line.style_no,
             'alternateStyleNo',line.alternate_style_no,'color',line.color,
             'quantity',line.quantity,'unitPrice',line.unit_price,
             'totalAmount',line.total_amount
           ) ORDER BY line.position)
           FROM sourcing_approval_snapshot_lines line
           WHERE line.sourcing_approval_snapshot_id=snapshot.sourcing_approval_snapshot_id
         ),'[]'::jsonb)
       ),
       array_remove(ARRAY[
         CASE WHEN snapshot.supplier_address IS NULL THEN 'address' END,
         CASE WHEN snapshot.contract_entity_name IS NULL THEN 'contractEntityName' END,
         CASE WHEN snapshot.party_b_representative IS NULL THEN 'partyBRepresentative' END,
         CASE WHEN snapshot.payee_name IS NULL THEN 'payeeName' END,
         CASE WHEN snapshot.bank_account IS NULL THEN 'bankAccount' END,
         CASE WHEN snapshot.bank_name IS NULL THEN 'bankName' END
       ],NULL)::text[],
       CASE WHEN snapshot.supplier_address IS NULL OR snapshot.contract_entity_name IS NULL
         OR snapshot.party_b_representative IS NULL OR snapshot.payee_name IS NULL
         OR snapshot.bank_account IS NULL OR snapshot.bank_name IS NULL
         THEN 'pending_supplement' ELSE 'generation_pending' END,
       snapshot.approved_by,snapshot.approved_at
FROM sourcing_approval_snapshots snapshot;

CREATE OR REPLACE FUNCTION guard_sourcing_contract_document_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.sourcing_contract_document_id<>OLD.sourcing_contract_document_id
    OR NEW.sourcing_case_id<>OLD.sourcing_case_id
    OR NEW.sourcing_approval_snapshot_id<>OLD.sourcing_approval_snapshot_id
    OR NEW.sourcing_decision_id<>OLD.sourcing_decision_id
    OR NEW.contract_version<>OLD.contract_version
    OR NEW.contract_number<>OLD.contract_number
    OR NEW.template_version<>OLD.template_version
    OR NEW.approval_snapshot<>OLD.approval_snapshot
    OR NEW.prepared_by<>OLD.prepared_by
    OR NEW.prepared_at<>OLD.prepared_at THEN
    RAISE EXCEPTION 'contract approval facts are immutable' USING ERRCODE='55000';
  END IF;
  IF OLD.status='ready' THEN
    RAISE EXCEPTION 'ready contract document is immutable' USING ERRCODE='55000';
  END IF;
  NEW.updated_at := CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$;

CREATE TRIGGER sourcing_contract_documents_guard_update
  BEFORE UPDATE ON sourcing_contract_documents FOR EACH ROW
  EXECUTE FUNCTION guard_sourcing_contract_document_update();
CREATE TRIGGER sourcing_contract_documents_no_delete
  BEFORE DELETE ON sourcing_contract_documents FOR EACH ROW
  EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER sourcing_contract_documents_no_truncate
  BEFORE TRUNCATE ON sourcing_contract_documents FOR EACH STATEMENT
  EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER sourcing_contract_supplements_no_update
  BEFORE UPDATE ON sourcing_contract_supplements FOR EACH ROW
  EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER sourcing_contract_supplements_no_delete
  BEFORE DELETE ON sourcing_contract_supplements FOR EACH ROW
  EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER sourcing_contract_supplements_no_truncate
  BEFORE TRUNCATE ON sourcing_contract_supplements FOR EACH STATEMENT
  EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER sourcing_contract_templates_no_update
  BEFORE UPDATE ON sourcing_contract_template_versions FOR EACH ROW
  EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER sourcing_contract_templates_no_delete
  BEFORE DELETE ON sourcing_contract_template_versions FOR EACH ROW
  EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER sourcing_contract_templates_no_truncate
  BEFORE TRUNCATE ON sourcing_contract_template_versions FOR EACH STATEMENT
  EXECUTE FUNCTION reject_operation_event_mutation();

CREATE OR REPLACE FUNCTION guard_sourcing_reconciliation_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  source_decision sourcing_decisions%ROWTYPE;
  source_approval sourcing_approval_snapshots%ROWTYPE;
  source_contract sourcing_contract_documents%ROWTYPE;
  previous_version integer;
  expected_action text;
BEGIN
  PERFORM 1 FROM sourcing_cases
  WHERE sourcing_case_id=NEW.sourcing_case_id FOR UPDATE;
  SELECT * INTO source_decision
  FROM sourcing_decisions
  WHERE sourcing_case_id=NEW.sourcing_case_id
  ORDER BY decision_version DESC LIMIT 1;
  SELECT * INTO source_approval
  FROM sourcing_approval_snapshots
  WHERE sourcing_decision_id=source_decision.sourcing_decision_id;
  SELECT * INTO source_contract
  FROM sourcing_contract_documents
  WHERE sourcing_contract_document_id=NEW.sourcing_contract_document_id;
  SELECT COALESCE(max(reconciliation_version),0) INTO previous_version
  FROM sourcing_finance_reconciliations
  WHERE sourcing_case_id=NEW.sourcing_case_id;

  IF sourcing_current_status(NEW.sourcing_case_id)<>'pending_finance_reconciliation'
    OR source_decision.sourcing_decision_id IS NULL
    OR source_approval.sourcing_approval_snapshot_id IS NULL
    OR NEW.sourcing_decision_id<>source_decision.sourcing_decision_id
    OR NEW.reconciliation_version<>previous_version+1 THEN
    RAISE EXCEPTION 'finance reconciliation must bind the current approved sourcing decision'
      USING ERRCODE='23514';
  END IF;
  IF source_contract.sourcing_contract_document_id IS NULL
    OR source_contract.status<>'ready'
    OR source_contract.sourcing_case_id<>NEW.sourcing_case_id
    OR source_contract.sourcing_approval_snapshot_id<>source_approval.sourcing_approval_snapshot_id
    OR NEW.contract_version<>source_contract.contract_version
    OR NEW.contract_fingerprint<>source_contract.snapshot_fingerprint THEN
    RAISE EXCEPTION 'finance reconciliation must bind the ready system contract PDF'
      USING ERRCODE='23514';
  END IF;
  IF NEW.actual_supplier_id<>source_approval.supplier_id
    OR NEW.actual_supplier_code_snapshot<>source_approval.supplier_code_snapshot
    OR NEW.actual_supplier_name_snapshot<>source_approval.supplier_name_snapshot
    OR NEW.actual_unit_price<>source_decision.unit_price
    OR NEW.actual_quantity<>source_approval.quantity
    OR NEW.actual_total_amount<>source_approval.total_amount THEN
    RAISE EXCEPTION 'finance facts must be copied from the immutable approval snapshot'
      USING ERRCODE='23514';
  END IF;
  IF (NEW.result='match' AND (cardinality(NEW.difference_fields)<>0 OR NEW.difference_reason IS NOT NULL))
    OR (NEW.result='difference' AND (
      cardinality(NEW.difference_fields)=0
      OR NOT (NEW.difference_fields <@ ARRAY['supplier','unit_price','quantity','total_amount']::text[])
      OR NEW.difference_reason IS NULL
    )) THEN
    RAISE EXCEPTION 'finance reconciliation declaration is invalid'
      USING ERRCODE='23514';
  END IF;

  expected_action := CASE NEW.result
    WHEN 'match' THEN 'sourcing.finance.matched'
    ELSE 'sourcing.finance.difference'
  END;
  PERFORM sourcing_require_operation_event(
    NEW.operation_event_id,NEW.request_id,NEW.reconciled_by,
    expected_action,'sourcing:finance:reconcile',
    NEW.sourcing_case_id,NEW.difference_reason
  );
  RETURN NEW;
END;
$$;
