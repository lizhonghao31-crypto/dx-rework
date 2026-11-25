-- Existing QC rows never acquire implied quantities. New explicit piece scopes
-- stay on the original immutable QC row, bound to the actual original return.
ALTER TABLE digital_factory_qc ADD COLUMN quantity_scope jsonb;

CREATE FUNCTION guard_native_craft_quality_quantity_scope() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  checked numeric;
  qualified numeric;
  problem numeric;
  actual numeric;
  already_checked numeric;
  matching_lines integer;
BEGIN
  PERFORM 1 FROM digital_factory_routes WHERE preparation_id=NEW.preparation_id FOR UPDATE;
  IF NEW.quantity_scope IS NULL THEN
    IF EXISTS (SELECT 1 FROM digital_factory_qc prior
      WHERE prior.preparation_id=NEW.preparation_id AND prior.return_fact_id=NEW.return_fact_id
        AND prior.line_id=NEW.line_id AND prior.quantity_scope IS NOT NULL) THEN
      RAISE EXCEPTION 'counted craft checks require exact quantities' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF jsonb_typeof(NEW.quantity_scope) IS DISTINCT FROM 'object'
    OR NEW.quantity_scope->>'unit' IS DISTINCT FROM '片'
    OR jsonb_typeof(NEW.quantity_scope->'inspectedQuantity') IS DISTINCT FROM 'number'
    OR jsonb_typeof(NEW.quantity_scope->'qualifiedQuantity') IS DISTINCT FROM 'number'
    OR jsonb_typeof(NEW.quantity_scope->'problemQuantity') IS DISTINCT FROM 'number' THEN
    RAISE EXCEPTION 'invalid counted craft check format' USING ERRCODE='23514';
  END IF;
  checked := (NEW.quantity_scope->>'inspectedQuantity')::numeric;
  qualified := (NEW.quantity_scope->>'qualifiedQuantity')::numeric;
  problem := (NEW.quantity_scope->>'problemQuantity')::numeric;
  SELECT count(*), max((line.value->>'quantity')::numeric) INTO matching_lines,actual
    FROM digital_factory_routes route
    JOIN digital_production_po_lines po ON po.production_order_id=route.production_order_id AND po.line_id=NEW.line_id
    JOIN digital_factory_facts received ON received.preparation_id=route.preparation_id
      AND received.fact_id=NEW.return_fact_id AND received.kind='工艺回仓'
    JOIN digital_factory_facts outgoing ON outgoing.preparation_id=route.preparation_id
      AND outgoing.fact_id::text=received.payload->>'sendFactId' AND outgoing.kind='工艺发出'
      AND outgoing.payload->>'stepRef'=received.payload->>'stepRef'
      AND outgoing.payload#>>'{warehouseMotion,factoryId}'=received.payload#>>'{warehouseMotion,factoryId}'
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(received.payload->'lines')='array' THEN received.payload->'lines' ELSE '[]'::jsonb END
    ) line(value)
    WHERE route.preparation_id=NEW.preparation_id AND route.route_schema_version=2
      AND line.value->>'lineId'=NEW.line_id::text AND jsonb_typeof(line.value->'quantity')='number';
  IF matching_lines<>1 OR actual IS NULL OR actual<>trunc(actual) OR checked<1 OR checked>actual OR checked>10000000 OR qualified<0 OR problem<0
    OR checked<>trunc(checked) OR qualified<>trunc(qualified) OR problem<>trunc(problem)
    OR qualified+problem<>checked OR (NEW.result='需处理') IS DISTINCT FROM (problem>0) THEN
    RAISE EXCEPTION 'counted craft check exceeds original return scope' USING ERRCODE='23514';
  END IF;
  -- Independent checks consume only the uninspected balance. Reinspection is
  -- a replacement of a single scope, separately verified by its own trigger.
  IF to_jsonb(NEW)->>'supersedes_check_id' IS NULL THEN
    SELECT coalesce(sum((prior.quantity_scope->>'inspectedQuantity')::numeric),0) INTO already_checked
      FROM digital_factory_qc prior WHERE prior.preparation_id=NEW.preparation_id AND prior.return_fact_id=NEW.return_fact_id
        AND prior.line_id=NEW.line_id AND prior.quantity_scope IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM digital_factory_qc replaced WHERE to_jsonb(replaced)->>'supersedes_check_id'=prior.check_id::text);
    IF already_checked+checked>actual THEN
      RAISE EXCEPTION 'counted craft check exceeds uninspected return balance' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER digital_factory_qc_native_quantity_scope
  BEFORE INSERT ON digital_factory_qc
  FOR EACH ROW EXECUTE FUNCTION guard_native_craft_quality_quantity_scope();
