-- SSP-04: carry every style/color price through IE, production management and owner approval.
-- Parent quote/decision amounts remain as the legacy compatibility projection; these immutable
-- line ledgers and approval snapshots are the authoritative multi-style contract facts.

CREATE TABLE sourcing_ie_quote_lines (
  sourcing_ie_quote_id uuid NOT NULL REFERENCES sourcing_ie_quotes(sourcing_ie_quote_id),
  sourcing_case_id uuid NOT NULL REFERENCES sourcing_cases(sourcing_case_id),
  position integer NOT NULL CHECK(position BETWEEN 1 AND 20),
  quantity integer NOT NULL CHECK(quantity BETWEEN 1 AND 10000000),
  unit_price numeric(18,4) NOT NULL CHECK(unit_price > 0),
  total_amount numeric(18,2) NOT NULL CHECK(total_amount > 0),
  PRIMARY KEY(sourcing_ie_quote_id,position),
  CHECK(total_amount=round(unit_price*quantity,2))
);

CREATE TABLE sourcing_decision_lines (
  sourcing_decision_id uuid NOT NULL REFERENCES sourcing_decisions(sourcing_decision_id),
  sourcing_case_id uuid NOT NULL REFERENCES sourcing_cases(sourcing_case_id),
  position integer NOT NULL CHECK(position BETWEEN 1 AND 20),
  quantity integer NOT NULL CHECK(quantity BETWEEN 1 AND 10000000),
  unit_price numeric(18,4) NOT NULL CHECK(unit_price > 0),
  total_amount numeric(18,2) NOT NULL CHECK(total_amount > 0),
  PRIMARY KEY(sourcing_decision_id,position),
  CHECK(total_amount=round(unit_price*quantity,2))
);

INSERT INTO sourcing_ie_quote_lines(
  sourcing_ie_quote_id,sourcing_case_id,position,quantity,unit_price,total_amount
)
SELECT quote.sourcing_ie_quote_id,quote.sourcing_case_id,line.position,line.quantity,
       quote.unit_price,round(quote.unit_price*line.quantity,2)
FROM sourcing_ie_quotes quote
JOIN sourcing_case_lines line ON line.sourcing_case_id=quote.sourcing_case_id;

INSERT INTO sourcing_decision_lines(
  sourcing_decision_id,sourcing_case_id,position,quantity,unit_price,total_amount
)
SELECT decision.sourcing_decision_id,decision.sourcing_case_id,line.position,line.quantity,
       decision.unit_price,round(decision.unit_price*line.quantity,2)
FROM sourcing_decisions decision
JOIN sourcing_case_lines line ON line.sourcing_case_id=decision.sourcing_case_id;

CREATE TABLE sourcing_approval_snapshots (
  sourcing_approval_snapshot_id uuid PRIMARY KEY,
  sourcing_case_id uuid NOT NULL REFERENCES sourcing_cases(sourcing_case_id),
  sourcing_decision_id uuid NOT NULL UNIQUE REFERENCES sourcing_decisions(sourcing_decision_id),
  decision_version integer NOT NULL CHECK(decision_version > 0),
  supplier_id uuid NOT NULL REFERENCES supplier_catalog_items(supplier_id),
  supplier_code_snapshot text NOT NULL,
  supplier_name_snapshot text NOT NULL,
  quantity integer NOT NULL CHECK(quantity BETWEEN 1 AND 10000000),
  total_amount numeric(18,2) NOT NULL CHECK(total_amount > 0),
  daxing_unit_price numeric(18,4) CHECK(daxing_unit_price IS NULL OR daxing_unit_price > 0),
  estimated_cut_piece_send_date date,
  delivery_date date,
  processes text[] NOT NULL DEFAULT '{}'::text[],
  approved_by uuid NOT NULL REFERENCES app_users(id),
  operation_event_id uuid NOT NULL UNIQUE REFERENCES operation_events(event_id),
  request_id text NOT NULL CHECK(request_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  approved_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE sourcing_approval_snapshot_lines (
  sourcing_approval_snapshot_id uuid NOT NULL
    REFERENCES sourcing_approval_snapshots(sourcing_approval_snapshot_id),
  position integer NOT NULL CHECK(position BETWEEN 1 AND 20),
  style_no text NOT NULL,
  alternate_style_no text,
  color text,
  quantity integer NOT NULL CHECK(quantity BETWEEN 1 AND 10000000),
  unit_price numeric(18,4) NOT NULL CHECK(unit_price > 0),
  total_amount numeric(18,2) NOT NULL CHECK(total_amount > 0),
  PRIMARY KEY(sourcing_approval_snapshot_id,position),
  CHECK(total_amount=round(unit_price*quantity,2))
);

-- Preserve already-approved history as immutable snapshots without inventing missing SSP-03 facts.
INSERT INTO sourcing_approval_snapshots(
  sourcing_approval_snapshot_id,sourcing_case_id,sourcing_decision_id,decision_version,
  supplier_id,supplier_code_snapshot,supplier_name_snapshot,quantity,total_amount,
  daxing_unit_price,estimated_cut_piece_send_date,delivery_date,processes,
  approved_by,operation_event_id,request_id,approved_at
)
SELECT owner.sourcing_owner_decision_id,decision.sourcing_case_id,decision.sourcing_decision_id,
       decision.decision_version,decision.supplier_id,decision.supplier_code_snapshot,
       decision.supplier_name_snapshot,decision.quantity,
       (SELECT sum(line.total_amount) FROM sourcing_decision_lines line
        WHERE line.sourcing_decision_id=decision.sourcing_decision_id),
       source_case.daxing_unit_price,source_case.estimated_cut_piece_send_date,
       source_case.delivery_date,COALESCE(source_case.process_items,'{}'::text[]),
       owner.decided_by,owner.operation_event_id,owner.request_id,owner.decided_at
FROM sourcing_owner_decisions owner
JOIN sourcing_decisions decision ON decision.sourcing_decision_id=owner.sourcing_decision_id
JOIN sourcing_cases source_case ON source_case.sourcing_case_id=decision.sourcing_case_id
WHERE owner.decision='approved';

INSERT INTO sourcing_approval_snapshot_lines(
  sourcing_approval_snapshot_id,position,style_no,alternate_style_no,color,
  quantity,unit_price,total_amount
)
SELECT snapshot.sourcing_approval_snapshot_id,line.position,source_line.style_no,
       source_line.alternate_style_no,source_line.color,line.quantity,line.unit_price,line.total_amount
FROM sourcing_approval_snapshots snapshot
JOIN sourcing_decision_lines line ON line.sourcing_decision_id=snapshot.sourcing_decision_id
JOIN sourcing_case_lines source_line
  ON source_line.sourcing_case_id=snapshot.sourcing_case_id AND source_line.position=line.position;

CREATE INDEX sourcing_approval_snapshots_case_idx
  ON sourcing_approval_snapshots(sourcing_case_id,decision_version DESC);

CREATE TRIGGER sourcing_ie_quote_lines_no_update BEFORE UPDATE ON sourcing_ie_quote_lines
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER sourcing_ie_quote_lines_no_delete BEFORE DELETE ON sourcing_ie_quote_lines
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER sourcing_decision_lines_no_update BEFORE UPDATE ON sourcing_decision_lines
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER sourcing_decision_lines_no_delete BEFORE DELETE ON sourcing_decision_lines
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER sourcing_approval_snapshots_no_update BEFORE UPDATE ON sourcing_approval_snapshots
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER sourcing_approval_snapshots_no_delete BEFORE DELETE ON sourcing_approval_snapshots
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER sourcing_approval_snapshot_lines_no_update BEFORE UPDATE ON sourcing_approval_snapshot_lines
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER sourcing_approval_snapshot_lines_no_delete BEFORE DELETE ON sourcing_approval_snapshot_lines
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER sourcing_ie_quote_lines_no_truncate BEFORE TRUNCATE ON sourcing_ie_quote_lines
  FOR EACH STATEMENT EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER sourcing_decision_lines_no_truncate BEFORE TRUNCATE ON sourcing_decision_lines
  FOR EACH STATEMENT EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER sourcing_approval_snapshots_no_truncate BEFORE TRUNCATE ON sourcing_approval_snapshots
  FOR EACH STATEMENT EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER sourcing_approval_snapshot_lines_no_truncate BEFORE TRUNCATE ON sourcing_approval_snapshot_lines
  FOR EACH STATEMENT EXECUTE FUNCTION reject_operation_event_mutation();
