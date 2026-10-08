-- Prospective PO identity and two independent effective promises.
-- No legacy number/date is guessed or backfilled; immutable historical rows survive.
ALTER TABLE digital_production_po_lines
 ADD COLUMN customer_warehouse_arrival_date date,
 ADD COLUMN factory_delivery_date date,
 ADD COLUMN customer_date_version integer NOT NULL DEFAULT 0 CHECK(customer_date_version>=0),
 ADD COLUMN factory_date_version integer NOT NULL DEFAULT 0 CHECK(factory_date_version>=0),
 ADD COLUMN customer_date_source text CHECK(customer_date_source IN ('initial_po','approved_customer_change')),
 ADD COLUMN factory_date_source text CHECK(factory_date_source='approved_factory_change'),
 ADD CONSTRAINT digital_po_factory_before_customer CHECK(
   factory_delivery_date IS NULL OR customer_warehouse_arrival_date IS NULL
   OR factory_delivery_date<=customer_warehouse_arrival_date
 );
CREATE TABLE digital_po_date_changes (
 change_id uuid PRIMARY KEY,
 production_order_id uuid NOT NULL,
 line_id uuid NOT NULL,
 date_kind text NOT NULL CHECK(date_kind IN ('customer','factory')),
 old_date date, new_date date NOT NULL,
 version integer NOT NULL CHECK(version>0),
 source text NOT NULL CHECK(source IN ('initial_po','approved_customer_change','approved_factory_change')),
 approval_event_id uuid NOT NULL REFERENCES audit_events(id),
 changed_by uuid NOT NULL REFERENCES app_users(id),
 request_id text NOT NULL,
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 500),
 created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(production_order_id,line_id) REFERENCES digital_production_po_lines(production_order_id,line_id),
 UNIQUE(line_id,date_kind,version), UNIQUE(line_id,date_kind,approval_event_id)
);
CREATE TRIGGER digital_po_date_changes_immutable BEFORE UPDATE OR DELETE ON digital_po_date_changes
 FOR EACH ROW EXECUTE FUNCTION guard_production_order_root_immutable();
CREATE TRIGGER digital_po_date_changes_no_truncate BEFORE TRUNCATE ON digital_po_date_changes
 FOR EACH STATEMENT EXECUTE FUNCTION guard_production_order_root_immutable();

CREATE FUNCTION guard_digital_po_number_identity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE formal text; candidate text;
BEGIN
 PERFORM 1 FROM digital_production_orders WHERE production_order_id=NEW.production_order_id FOR UPDATE;
 formal:=COALESCE(NULLIF(btrim(NEW.formal_style_no),''),NULLIF(btrim(NEW.po_number),''));
 IF NULLIF(btrim(NEW.formal_style_no),'') IS NOT NULL AND NULLIF(btrim(NEW.po_number),'') IS NOT NULL
   AND normalize_sourcing_style_key(NEW.formal_style_no)<>normalize_sourcing_style_key(NEW.po_number) THEN
   RAISE EXCEPTION 'formal style number and PO must have one effective value' USING ERRCODE='23514';
 END IF;
 candidate:=normalize_sourcing_style_key(formal);
 IF candidate IS NOT NULL AND EXISTS(SELECT 1 FROM digital_production_po_lines line
   WHERE line.production_order_id=NEW.production_order_id AND line.line_id<>NEW.line_id
   AND candidate IN (normalize_sourcing_style_key(line.formal_style_no),normalize_sourcing_style_key(line.po_number))) THEN
   RAISE EXCEPTION 'formal PO must be unique within the same mother order' USING ERRCODE='23505';
 END IF;
 NEW.po_number:=formal; NEW.formal_style_no:=formal;
 RETURN NEW;
END;
$$;
CREATE TRIGGER digital_po_number_identity_guard BEFORE INSERT OR UPDATE OF po_number,formal_style_no ON digital_production_po_lines
 FOR EACH ROW EXECUTE FUNCTION guard_digital_po_number_identity();

CREATE FUNCTION guard_digital_po_date_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE line digital_production_po_lines%ROWTYPE; approval audit_events%ROWTYPE;
 current_date_value date; current_version integer; expected_action text;
BEGIN
 IF NEW.date_kind='factory' THEN
   PERFORM s.sourcing_case_id FROM sourcing_cases s JOIN digital_production_child_links link
     ON link.module='sourcing' AND link.child_id=s.sourcing_case_id
     WHERE link.production_order_id=NEW.production_order_id ORDER BY s.sourcing_case_id FOR UPDATE OF s;
   IF EXISTS(SELECT 1 FROM sourcing_finance_reconciliations finance JOIN digital_production_child_links link
     ON link.module='sourcing' AND link.child_id=finance.sourcing_case_id
     WHERE link.production_order_id=NEW.production_order_id) THEN
     RAISE EXCEPTION 'finance reconciliation permanently locks the factory promise' USING ERRCODE='55000';
   END IF;
 END IF;
 SELECT * INTO line FROM digital_production_po_lines WHERE line_id=NEW.line_id FOR UPDATE;
 SELECT * INTO approval FROM audit_events WHERE id=NEW.approval_event_id;
 current_date_value:=CASE NEW.date_kind WHEN 'customer' THEN line.customer_warehouse_arrival_date ELSE line.factory_delivery_date END;
 current_version:=CASE NEW.date_kind WHEN 'customer' THEN line.customer_date_version ELSE line.factory_date_version END;
 expected_action:=CASE NEW.source WHEN 'initial_po' THEN 'digital_order_created'
   WHEN 'approved_customer_change' THEN 'digital_po_customer_dates_approved' ELSE 'digital_po_factory_dates_approved' END;
 IF line.production_order_id IS DISTINCT FROM NEW.production_order_id
   OR current_date_value IS DISTINCT FROM NEW.old_date OR NEW.version<>current_version+1
   OR approval.id IS NULL OR approval.actor_id IS DISTINCT FROM NEW.changed_by
   OR approval.request_id IS DISTINCT FROM NEW.request_id OR approval.action IS DISTINCT FROM expected_action
   OR approval.entity_type IS DISTINCT FROM 'digital_production'
   OR approval.entity_id IS DISTINCT FROM NEW.production_order_id::text
   OR (NEW.date_kind='customer' AND NEW.source='approved_factory_change')
   OR (NEW.date_kind='factory' AND NEW.source<>'approved_factory_change') THEN
   RAISE EXCEPTION 'PO date changes require the current version and matching approval audit' USING ERRCODE='55000';
 END IF;
 IF NEW.source='initial_po' THEN
   IF NEW.version<>1 OR NEW.old_date IS NOT NULL OR NEW.date_kind<>'customer'
     OR NEW.new_date::text IS DISTINCT FROM COALESCE(
       approval.after_state->'lines'->(line.position-1)->>'customerWarehouseArrivalDate',
       approval.after_state->'lines'->(line.position-1)->>'deliveryDate') THEN
     RAISE EXCEPTION 'initial PO date must be explicitly recorded on this creation' USING ERRCODE='55000';
   END IF;
 ELSE
   IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(approval.after_state->'dateChanges') evidence(change)
     WHERE evidence.change->>'lineId'=NEW.line_id::text
       AND evidence.change->>'dateKind'=NEW.date_kind
       AND evidence.change->>'oldDate' IS NOT DISTINCT FROM NEW.old_date::text
       AND evidence.change->>'date'=NEW.new_date::text
       AND evidence.change->>'expectedVersion'=current_version::text) THEN
     RAISE EXCEPTION 'PO date must match the exact approved line and date' USING ERRCODE='55000';
   END IF;
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER digital_po_date_changes_guard BEFORE INSERT ON digital_po_date_changes
 FOR EACH ROW EXECUTE FUNCTION guard_digital_po_date_change();

CREATE FUNCTION guard_digital_po_date_commit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_version integer; current_value date;
BEGIN
 SELECT CASE NEW.date_kind WHEN 'customer' THEN customer_date_version ELSE factory_date_version END,
        CASE NEW.date_kind WHEN 'customer' THEN customer_warehouse_arrival_date ELSE factory_delivery_date END
 INTO current_version,current_value FROM digital_production_po_lines WHERE line_id=NEW.line_id;
 IF current_version IS NULL OR current_version<NEW.version
   OR (current_version=NEW.version AND current_value IS DISTINCT FROM NEW.new_date) THEN
   RAISE EXCEPTION 'appended PO date fact must become effective in the same transaction' USING ERRCODE='55000';
 END IF;
 RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER digital_po_date_changes_commit AFTER INSERT ON digital_po_date_changes
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION guard_digital_po_date_commit();

CREATE FUNCTION guard_digital_po_date_effective() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN
   IF NEW.customer_warehouse_arrival_date IS NOT NULL OR NEW.factory_delivery_date IS NOT NULL
     OR NEW.customer_date_version<>0 OR NEW.factory_date_version<>0
     OR NEW.customer_date_source IS NOT NULL OR NEW.factory_date_source IS NOT NULL THEN
     RAISE EXCEPTION 'effective PO dates must be initialized by audited facts' USING ERRCODE='55000';
   END IF;
 ELSE
   IF ROW(NEW.customer_warehouse_arrival_date,NEW.customer_date_version,NEW.customer_date_source)
     IS DISTINCT FROM ROW(OLD.customer_warehouse_arrival_date,OLD.customer_date_version,OLD.customer_date_source)
     AND NOT EXISTS(SELECT 1 FROM digital_po_date_changes fact WHERE fact.line_id=NEW.line_id
       AND fact.date_kind='customer' AND fact.version=OLD.customer_date_version+1
       AND NEW.customer_date_version=fact.version AND fact.old_date IS NOT DISTINCT FROM OLD.customer_warehouse_arrival_date
       AND fact.new_date=NEW.customer_warehouse_arrival_date AND fact.source=NEW.customer_date_source) THEN
     RAISE EXCEPTION 'customer promise requires one matching appended date fact' USING ERRCODE='55000';
   END IF;
   IF ROW(NEW.factory_delivery_date,NEW.factory_date_version,NEW.factory_date_source)
     IS DISTINCT FROM ROW(OLD.factory_delivery_date,OLD.factory_date_version,OLD.factory_date_source)
     AND NOT EXISTS(SELECT 1 FROM digital_po_date_changes fact WHERE fact.line_id=NEW.line_id
       AND fact.date_kind='factory' AND fact.version=OLD.factory_date_version+1
       AND NEW.factory_date_version=fact.version AND fact.old_date IS NOT DISTINCT FROM OLD.factory_delivery_date
       AND fact.new_date=NEW.factory_delivery_date AND fact.source=NEW.factory_date_source) THEN
     RAISE EXCEPTION 'factory promise requires one matching appended date fact' USING ERRCODE='55000';
   END IF;
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER digital_po_date_effective_guard BEFORE INSERT OR UPDATE ON digital_production_po_lines
 FOR EACH ROW EXECUTE FUNCTION guard_digital_po_date_effective();
