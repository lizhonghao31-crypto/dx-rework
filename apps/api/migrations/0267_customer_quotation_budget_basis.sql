-- Customer quotation is distinct from the existing sourcing/IE execution quote.
-- Enrol only newly inserted formal orders. Historical budgets are not certified.
CREATE TABLE digital_commercial_order_rules (
 production_order_id uuid PRIMARY KEY REFERENCES digital_production_orders(production_order_id),
 policy text NOT NULL DEFAULT 'quote_v1' CHECK(policy='quote_v1'),
 adopted_by uuid NOT NULL REFERENCES app_users(id),
 adopted_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE FUNCTION enrol_customer_quotation_policy() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO digital_commercial_order_rules(production_order_id,adopted_by) VALUES(NEW.production_order_id,NEW.created_by);
 RETURN NEW;
END $$;
CREATE TRIGGER digital_customer_quotation_policy AFTER INSERT ON digital_production_orders
 FOR EACH ROW EXECUTE FUNCTION enrol_customer_quotation_policy();
CREATE TRIGGER digital_commercial_rule_immutable BEFORE UPDATE OR DELETE ON digital_commercial_order_rules
 FOR EACH ROW EXECUTE FUNCTION guard_production_order_root_immutable();

CREATE TABLE digital_quotation_documents (
 quote_id uuid PRIMARY KEY,
 source_id uuid UNIQUE REFERENCES digital_production_sources(source_id),
 production_order_id uuid UNIQUE REFERENCES digital_production_orders(production_order_id),
 version integer NOT NULL CHECK(version>0),
 document jsonb NOT NULL CHECK(jsonb_typeof(document)='object'),
 assignments jsonb NOT NULL CHECK(jsonb_typeof(assignments)='array'),
 consumption_sources jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(consumption_sources)='object'),
 price_sources jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(price_sources)='object'),
 confirmed_version integer,
 updated_by uuid NOT NULL REFERENCES app_users(id),
 updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(production_order_id,quote_id),
 CHECK(num_nonnulls(source_id,production_order_id)>=1)
);
CREATE TABLE digital_quotation_versions (
 quote_id uuid NOT NULL REFERENCES digital_quotation_documents(quote_id),
 version integer NOT NULL CHECK(version>0),
 document jsonb NOT NULL CHECK(jsonb_typeof(document)='object'),
 assignments jsonb NOT NULL CHECK(jsonb_typeof(assignments)='array'),
 consumption_sources jsonb NOT NULL CHECK(jsonb_typeof(consumption_sources)='object'),
 price_sources jsonb NOT NULL CHECK(jsonb_typeof(price_sources)='object'),
 confirmation jsonb NOT NULL CHECK(jsonb_typeof(confirmation)='object'),
 customer_code text NOT NULL REFERENCES digital_production_customers(code),
 confirmed_quote_total numeric(44,12) NOT NULL CHECK(confirmed_quote_total>=0),
 confirmed_by_internal uuid NOT NULL REFERENCES app_users(id),
 recorded_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK(confirmed_quote_total=(confirmation->>'customerConfirmedTotal')::numeric),
 CHECK(customer_code=confirmation->>'customerCode'),
 CHECK(confirmation->>'sourceField'='customerConfirmedTotal' AND confirmation->>'sourceKind'='explicit_customer_confirmation' AND confirmation->>'templateVersion'='online-quotation-v1'),
 PRIMARY KEY(quote_id,version)
);
ALTER TABLE digital_quotation_documents ADD CONSTRAINT quotation_confirmed_version_fk
 FOREIGN KEY(quote_id,confirmed_version) REFERENCES digital_quotation_versions(quote_id,version);
CREATE TRIGGER digital_quotation_version_immutable BEFORE UPDATE OR DELETE ON digital_quotation_versions
 FOR EACH ROW EXECUTE FUNCTION guard_production_order_root_immutable();
CREATE FUNCTION guard_quotation_resource() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'quotation history is retained' USING ERRCODE='55000'; END IF;
 IF TG_OP='UPDATE' AND (NEW.quote_id<>OLD.quote_id OR NEW.source_id IS DISTINCT FROM OLD.source_id
    OR (OLD.production_order_id IS NOT NULL AND NEW.production_order_id IS DISTINCT FROM OLD.production_order_id)) THEN
   RAISE EXCEPTION 'quotation resource cannot be rebound' USING ERRCODE='23514';
 END IF;
 IF NEW.source_id IS NOT NULL AND NEW.production_order_id IS NOT NULL AND NOT EXISTS(
   SELECT 1 FROM digital_production_orders WHERE production_order_id=NEW.production_order_id AND source_id=NEW.source_id
 ) THEN RAISE EXCEPTION 'quotation source/order mismatch' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER digital_quotation_resource_guard BEFORE INSERT OR UPDATE OR DELETE ON digital_quotation_documents
 FOR EACH ROW EXECUTE FUNCTION guard_quotation_resource();

CREATE TABLE digital_budget_quote_conversions (
 production_order_id uuid NOT NULL REFERENCES digital_production_orders(production_order_id),
 quote_id uuid NOT NULL,
 quote_version integer NOT NULL,
 created_budget_version integer NOT NULL CHECK(created_budget_version>0),
 created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(production_order_id,quote_id,quote_version),
 FOREIGN KEY(production_order_id,quote_id) REFERENCES digital_quotation_documents(production_order_id,quote_id),
 FOREIGN KEY(quote_id,quote_version) REFERENCES digital_quotation_versions(quote_id,version)
);
CREATE TRIGGER digital_budget_conversion_immutable BEFORE UPDATE OR DELETE ON digital_budget_quote_conversions
 FOR EACH ROW EXECUTE FUNCTION guard_production_order_root_immutable();
ALTER TABLE digital_budget_documents ADD COLUMN quote_id uuid;
ALTER TABLE digital_budget_documents ADD COLUMN quote_version integer;
ALTER TABLE digital_budget_documents ADD CONSTRAINT budget_quote_basis_fk FOREIGN KEY(production_order_id,quote_id,quote_version)
 REFERENCES digital_budget_quote_conversions(production_order_id,quote_id,quote_version);
ALTER TABLE digital_budget_documents ADD CHECK((quote_id IS NULL)=(quote_version IS NULL));
ALTER TABLE digital_budget_versions ADD COLUMN quote_id uuid;
ALTER TABLE digital_budget_versions ADD COLUMN quote_version integer;
ALTER TABLE digital_budget_versions ADD COLUMN budget_comparable_total numeric(44,12);
ALTER TABLE digital_budget_versions ADD COLUMN confirmed_quote_total numeric(44,12);
ALTER TABLE digital_budget_versions ADD CONSTRAINT published_budget_quote_basis_fk FOREIGN KEY(production_order_id,quote_id,quote_version)
 REFERENCES digital_budget_quote_conversions(production_order_id,quote_id,quote_version);
ALTER TABLE digital_budget_versions ADD CHECK((quote_id IS NULL AND quote_version IS NULL AND budget_comparable_total IS NULL AND confirmed_quote_total IS NULL)
 OR (quote_id IS NOT NULL AND quote_version IS NOT NULL AND budget_comparable_total IS NOT NULL AND confirmed_quote_total IS NOT NULL AND budget_comparable_total>=0 AND confirmed_quote_total>=budget_comparable_total));
CREATE FUNCTION guard_customer_quotation_budget_publication() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM digital_commercial_order_rules WHERE production_order_id=NEW.production_order_id) THEN
  IF NEW.quote_id IS NULL OR NOT EXISTS(
   SELECT 1 FROM digital_quotation_documents q JOIN digital_quotation_versions v ON v.quote_id=q.quote_id AND v.version=q.confirmed_version
    JOIN digital_production_orders o ON o.production_order_id=q.production_order_id AND o.customer_code=v.customer_code
   WHERE q.production_order_id=NEW.production_order_id AND q.quote_id=NEW.quote_id AND q.confirmed_version=NEW.quote_version
     AND v.confirmed_quote_total=NEW.confirmed_quote_total
  ) OR NEW.budget_comparable_total IS NULL OR NEW.budget_comparable_total>NEW.confirmed_quote_total THEN
   RAISE EXCEPTION 'new budget requires current confirmed customer quotation within limit' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER customer_quotation_budget_publication BEFORE INSERT ON digital_budget_versions
 FOR EACH ROW EXECUTE FUNCTION guard_customer_quotation_budget_publication();
