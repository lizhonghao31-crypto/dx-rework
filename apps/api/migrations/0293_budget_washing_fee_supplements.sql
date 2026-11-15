-- An explicitly published washing-only revision retains the original budget
-- document format and approved quote basis. Adopted sourcing/contracts remain
-- pinned to their original version; no backfill or automatic fee is created.
ALTER TABLE digital_budget_versions ADD COLUMN washing_supplement jsonb
 CHECK(washing_supplement IS NULL OR coalesce((jsonb_typeof(washing_supplement)='object'
  AND washing_supplement->>'kind'='washing_fee'
  AND washing_supplement->>'action' IN ('new','adjust')
  AND jsonb_typeof(washing_supplement->'baseVersion')='number'
  AND jsonb_typeof(washing_supplement->'reason')='string'
  AND length(btrim(washing_supplement->>'reason')) BETWEEN 1 AND 2000),false));

-- A narrow washing supplement keeps its already adopted quote basis rather
-- than silently adopting a later customer quote or changing a contract. All
-- ordinary new budget publications retain the original current-quote guard.
CREATE OR REPLACE FUNCTION guard_customer_quotation_budget_publication() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE basis digital_budget_versions%ROWTYPE; old_rows jsonb; new_rows jsonb; changed jsonb; target text;
BEGIN
 IF NEW.washing_supplement IS NOT NULL THEN
  SELECT * INTO basis FROM digital_budget_versions WHERE production_order_id=NEW.production_order_id
   AND version=(NEW.washing_supplement->>'baseVersion')::integer;
  target:=NEW.washing_supplement->>'rowId';
  IF NOT FOUND OR NEW.version<>basis.version+1 OR NEW.quote_id IS DISTINCT FROM basis.quote_id
   OR NEW.quote_version IS DISTINCT FROM basis.quote_version
   OR (NEW.document-'rows') IS DISTINCT FROM (basis.document-'rows')
   OR NOT EXISTS(SELECT 1 FROM digital_production_po_lines l JOIN digital_bulk_washing_plans p ON p.plan_id=l.bulk_washing_plan_id
    WHERE l.production_order_id=NEW.production_order_id AND l.line_id::text=NEW.washing_supplement->>'lineId'
     AND p.document->'arrangement'->>'mode'<>'none') THEN
   RAISE EXCEPTION 'washing supplement must retain its original order, budget and quote basis' USING ERRCODE='23514';
  END IF;
  SELECT coalesce(jsonb_agg(r ORDER BY position),'[]') INTO old_rows FROM jsonb_array_elements(basis.document->'rows') WITH ORDINALITY x(r,position) WHERE r->>'rowId' IS DISTINCT FROM target;
  SELECT coalesce(jsonb_agg(r ORDER BY position),'[]') INTO new_rows FROM jsonb_array_elements(NEW.document->'rows') WITH ORDINALITY x(r,position) WHERE r->>'rowId' IS DISTINCT FROM target;
  SELECT r INTO changed FROM jsonb_array_elements(NEW.document->'rows') r WHERE r->>'rowId'=target;
  IF old_rows IS DISTINCT FROM new_rows OR changed IS NULL OR changed->>'section' IS DISTINCT FROM '外发工序'
   OR changed->>'category' IS DISTINCT FROM '洗水'
   OR (SELECT count(*) FROM jsonb_array_elements(NEW.document->'rows') r WHERE r->>'rowId'=target)<>1
   OR (NEW.washing_supplement->>'action'='new' AND EXISTS(SELECT 1 FROM jsonb_array_elements(basis.document->'rows') r WHERE r->>'rowId'=target))
   OR (NEW.washing_supplement->>'action'='adjust' AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(basis.document->'rows') r
     WHERE r->>'rowId'=target AND r->>'section'='外发工序' AND r->>'category'='洗水')) THEN
   RAISE EXCEPTION 'washing supplement may only add or adjust its washing row' USING ERRCODE='23514';
  END IF;
  IF NEW.washing_supplement->>'action'='adjust' AND NOT EXISTS(
   SELECT 1 FROM digital_production_po_lines l JOIN digital_bulk_washing_plans p ON p.plan_id=l.bulk_washing_plan_id
   WHERE l.production_order_id=NEW.production_order_id AND l.line_id::text=NEW.washing_supplement->>'lineId'
    AND p.document->'fee'->>'kind'='budget_row' AND p.document->'fee'->>'rowId'=target
  ) THEN RAISE EXCEPTION 'washing adjustment must match this PO current fee reference' USING ERRCODE='23514'; END IF;
  IF EXISTS(SELECT 1 FROM digital_commercial_order_rules WHERE production_order_id=NEW.production_order_id) AND (
   NEW.quote_id IS NULL OR NOT EXISTS(SELECT 1 FROM digital_quotation_versions v JOIN digital_production_orders o ON o.production_order_id=NEW.production_order_id
    WHERE v.quote_id=NEW.quote_id AND v.version=NEW.quote_version AND v.customer_code=o.customer_code AND v.confirmed_quote_total=NEW.confirmed_quote_total)
   OR NEW.budget_comparable_total IS NULL OR NEW.budget_comparable_total>NEW.confirmed_quote_total) THEN
   RAISE EXCEPTION 'washing supplement exceeds its original confirmed quotation basis' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
 END IF;
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
