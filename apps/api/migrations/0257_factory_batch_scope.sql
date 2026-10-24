-- Preserve historical whole-order routes; new routes explicitly opt into scoped facts.
ALTER TABLE digital_factory_routes ADD COLUMN workflow_version integer NOT NULL DEFAULT 1 CHECK(workflow_version IN (1,2));
ALTER TABLE digital_factory_qc ADD COLUMN allow_dispatch boolean NOT NULL DEFAULT false;
ALTER TABLE digital_factory_qc ADD COLUMN dispatch_reason text NOT NULL DEFAULT '';
ALTER TABLE digital_factory_qc ADD CONSTRAINT factory_failed_release_reason CHECK(NOT allow_dispatch OR result='需处理' AND length(btrim(dispatch_reason))>0);
DROP INDEX digital_factory_one_dispatch;
CREATE UNIQUE INDEX digital_factory_one_legacy_dispatch ON digital_factory_facts(preparation_id) WHERE kind='仓库实际发厂' AND NOT(payload ? 'lines');
CREATE FUNCTION guard_factory_batch_scope() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE route digital_factory_routes%ROWTYPE; item jsonb;
BEGIN
 SELECT * INTO route FROM digital_factory_routes WHERE preparation_id=NEW.preparation_id;
 IF NEW.kind NOT IN ('工艺发出','工艺回仓','仓库实际发厂') THEN RETURN NEW; END IF;
 IF route.workflow_version=1 THEN
  IF NEW.payload ? 'lines' THEN RAISE EXCEPTION 'historical factory route cannot adopt batch scope' USING ERRCODE='55000'; END IF;
 ELSE
  IF jsonb_typeof(NEW.payload->'lines') IS DISTINCT FROM 'array' OR jsonb_array_length(NEW.payload->'lines')=0 THEN RAISE EXCEPTION 'factory batch requires explicit quantities' USING ERRCODE='55000'; END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(NEW.payload->'lines') LOOP
   IF jsonb_typeof(item->'quantity') IS DISTINCT FROM 'number' OR (item->>'quantity')!~'^[1-9][0-9]*$' OR (item->>'quantity')::numeric>10000000
    OR NOT EXISTS(SELECT 1 FROM digital_production_po_lines WHERE production_order_id=route.production_order_id AND line_id::text=item->>'lineId') THEN RAISE EXCEPTION 'invalid factory batch PO or quantity' USING ERRCODE='55000'; END IF;
  END LOOP;
  IF (SELECT count(*)<>count(DISTINCT value->>'lineId') FROM jsonb_array_elements(NEW.payload->'lines')) THEN RAISE EXCEPTION 'duplicate factory batch PO' USING ERRCODE='55000'; END IF;
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER factory_batch_scope BEFORE INSERT ON digital_factory_facts FOR EACH ROW EXECUTE FUNCTION guard_factory_batch_scope();
