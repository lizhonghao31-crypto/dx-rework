-- P01: new identities only; no historical business data backfill.
CREATE TABLE digital_production_customers (
  code text PRIMARY KEY, name text NOT NULL,
  product_groups text[] NOT NULL CHECK(cardinality(product_groups)>0), enabled boolean NOT NULL DEFAULT true
);
INSERT INTO digital_production_customers(code,name,product_groups) VALUES
 ('PD','PADINI',ARRAY['男装','女装']),('PI','PDI',ARRAY['男装','女装']),
 ('SE','SEED',ARRAY['男装','女装']),('PA','PADINI AUTHENTICS',ARRAY['男装','女装']),
 ('GA','GARAGE',ARRAY['男装','女装']),('IN','INDUSTRIE',ARRAY['男装','女装']),
 ('RO','ROPE',ARRAY['男装','女装']),('PT','PORTOFINO',ARRAY['男装','女装']),
 ('ST','STUDIO',ARRAY['男装','女装']),('BO-IP','BO（IP联名款）',ARRAY['男装','女装']),
 ('IN-POLO','IN-POLO',ARRAY['男装']),('OC','OCEANO',ARRAY['男装']),
 ('GM','GAMESTER',ARRAY['男童']),('SEED-K','SEED-K',ARRAY['男童']),
 ('HO','HOTSHOTS',ARRAY['女童']),('FL','FILANTO',ARRAY['女装'])
ON CONFLICT(code) DO NOTHING;

CREATE TABLE digital_production_sources (
 source_id uuid PRIMARY KEY, created_by uuid NOT NULL REFERENCES app_users(id),
 development_type text NOT NULL CHECK(development_type IN ('头版','开发板')),
 design_style_no text NOT NULL CHECK(length(btrim(design_style_no)) BETWEEN 1 AND 100),
 temporary_style_no text, customer_code text REFERENCES digital_production_customers(code),
 created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE digital_production_orders (
 production_order_id uuid PRIMARY KEY REFERENCES production_order_roots(production_order_id),
 source_id uuid UNIQUE REFERENCES digital_production_sources(source_id),
 customer_code text NOT NULL REFERENCES digital_production_customers(code),
 product_group text NOT NULL CHECK(product_group IN ('男装','女装','男童','女童')),
 design_style_no text NOT NULL CHECK(length(btrim(design_style_no)) BETWEEN 1 AND 100), temporary_style_no text,
 order_date date NOT NULL, contract_delivery_date date,
 primary_merchandiser_id uuid REFERENCES app_users(id),
 created_by uuid NOT NULL REFERENCES app_users(id), created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 version integer NOT NULL DEFAULT 1 CHECK(version>0),
 notification_policy text NOT NULL DEFAULT 'IN_APP_ONLY' CHECK(notification_policy='IN_APP_ONLY')
);
CREATE INDEX digital_production_orders_creator_idx ON digital_production_orders(created_by,created_at DESC,production_order_id);
CREATE INDEX digital_production_sources_creator_idx ON digital_production_sources(created_by,created_at DESC,source_id);
CREATE TABLE digital_production_po_lines (
 line_id uuid PRIMARY KEY, production_order_id uuid NOT NULL REFERENCES digital_production_orders(production_order_id),
 position integer NOT NULL CHECK(position>0), po_number text, formal_style_no text, temporary_style_no text,
 color text NOT NULL CHECK(length(btrim(color)) BETWEEN 1 AND 100), color_foreign text, delivery_date date,
 UNIQUE(production_order_id,position), UNIQUE(production_order_id,line_id)
);
CREATE UNIQUE INDEX digital_production_po_color_unique ON digital_production_po_lines(production_order_id,lower(btrim(color)));
CREATE TABLE digital_production_po_sizes (
 line_id uuid NOT NULL REFERENCES digital_production_po_lines(line_id), size text NOT NULL CHECK(length(btrim(size)) BETWEEN 1 AND 100),
 quantity integer NOT NULL CHECK(quantity BETWEEN 1 AND 10000000), PRIMARY KEY(line_id,size)
);
-- Explicit durable lifecycle identity. Later adapters must resolve with an explicit generation,
-- never infer legacy from a missing mapping or from a style-number/date match.
CREATE TABLE digital_production_child_links (
 module text NOT NULL CHECK(module IN ('sourcing','cutting','production','receiving','rework','pattern_room')),
 child_id uuid NOT NULL, production_order_id uuid NOT NULL REFERENCES digital_production_orders(production_order_id),
 workflow_generation text NOT NULL DEFAULT 'digital_production_v1' CHECK(workflow_generation='digital_production_v1'),
 created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(module,child_id), UNIQUE(module,child_id,production_order_id)
);
CREATE UNIQUE INDEX digital_production_one_sourcing ON digital_production_child_links(production_order_id) WHERE module='sourcing';
CREATE TABLE digital_production_child_lines (
 module text NOT NULL, child_id uuid NOT NULL, child_line_key text NOT NULL,
 production_order_id uuid NOT NULL, line_id uuid NOT NULL,
 PRIMARY KEY(module,child_id,child_line_key),
 FOREIGN KEY(module,child_id,production_order_id) REFERENCES digital_production_child_links(module,child_id,production_order_id),
 FOREIGN KEY(production_order_id,line_id) REFERENCES digital_production_po_lines(production_order_id,line_id)
);
CREATE TRIGGER digital_production_child_links_immutable BEFORE UPDATE OR DELETE ON digital_production_child_links
 FOR EACH ROW EXECUTE FUNCTION guard_production_order_root_immutable();
CREATE TRIGGER digital_production_child_lines_immutable BEFORE UPDATE OR DELETE ON digital_production_child_lines
 FOR EACH ROW EXECUTE FUNCTION guard_production_order_root_immutable();
ALTER TABLE digital_production_orders ADD COLUMN creation_hash text NOT NULL;
CREATE TABLE digital_production_commands (
 actor_id uuid NOT NULL REFERENCES app_users(id), command text NOT NULL, key text NOT NULL,
 payload_hash text NOT NULL, response jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(actor_id,command,key)
);
CREATE TRIGGER digital_production_commands_immutable BEFORE UPDATE OR DELETE ON digital_production_commands
 FOR EACH ROW EXECUTE FUNCTION guard_production_order_root_immutable();
ALTER TABLE digital_production_child_links
 ADD COLUMN sourcing_case_id uuid GENERATED ALWAYS AS (CASE WHEN module='sourcing' THEN child_id END) STORED REFERENCES sourcing_cases(sourcing_case_id),
 ADD COLUMN cutting_order_id uuid GENERATED ALWAYS AS (CASE WHEN module='cutting' THEN child_id END) STORED REFERENCES cutting_orders(cutting_order_id),
 ADD COLUMN factory_order_id uuid GENERATED ALWAYS AS (CASE WHEN module='production' THEN child_id END) STORED REFERENCES sourcing_production_orders(production_order_id),
 ADD COLUMN receipt_id uuid GENERATED ALWAYS AS (CASE WHEN module='receiving' THEN child_id END) STORED REFERENCES receiving_receipts(receipt_id),
 ADD COLUMN rework_order_id uuid GENERATED ALWAYS AS (CASE WHEN module='rework' THEN child_id END) STORED REFERENCES rework_orders(rework_order_id),
 ADD COLUMN pattern_order_id uuid GENERATED ALWAYS AS (CASE WHEN module='pattern_room' THEN child_id END) STORED REFERENCES pattern_room_orders(order_id);
CREATE UNIQUE INDEX digital_production_one_factory_order ON digital_production_child_links(production_order_id) WHERE module='production';
CREATE FUNCTION guard_digital_child_sourcing() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE case_id uuid;
BEGIN
 IF NEW.module='production' THEN
   SELECT sourcing_case_id INTO case_id FROM sourcing_production_orders WHERE production_order_id=NEW.child_id;
 ELSIF NEW.module='cutting' THEN
   SELECT sourcing_case_id INTO case_id FROM cutting_orders WHERE cutting_order_id=NEW.child_id;
 ELSE RETURN NEW;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM digital_production_child_links WHERE module='sourcing' AND child_id=case_id AND production_order_id=NEW.production_order_id) THEN
   RAISE EXCEPTION 'digital child must use the same whole-order sourcing case' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER digital_child_sourcing_guard BEFORE INSERT ON digital_production_child_links FOR EACH ROW EXECUTE FUNCTION guard_digital_child_sourcing();
CREATE FUNCTION guard_digital_order_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'digital identity cannot be deleted' USING ERRCODE='55000'; END IF;
 IF NEW.production_order_id<>OLD.production_order_id OR NEW.created_by<>OLD.created_by OR NEW.created_at<>OLD.created_at
    OR (OLD.source_id IS NOT NULL AND NEW.source_id IS DISTINCT FROM OLD.source_id) THEN
   RAISE EXCEPTION 'digital identity cannot be rebound' USING ERRCODE='55000';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER digital_order_identity_guard BEFORE UPDATE OR DELETE ON digital_production_orders FOR EACH ROW EXECUTE FUNCTION guard_digital_order_identity();
CREATE TRIGGER digital_source_identity_guard BEFORE UPDATE OR DELETE ON digital_production_sources FOR EACH ROW EXECUTE FUNCTION guard_production_order_root_immutable();
