-- New digital contracts freeze each explicitly approved PO promise. No date or
-- mapping is backfilled into old documents, approvals, signatures or monitors.
CREATE OR REPLACE FUNCTION sourcing_effective_delivery_date(case_id uuid, fallback_date date, at_time timestamptz DEFAULT NULL)
RETURNS date LANGUAGE plpgsql STABLE AS $$
DECLARE edited text; earliest date;
BEGIN
  SELECT min(CASE WHEN at_time IS NULL THEN po.factory_delivery_date ELSE (
    SELECT fact.new_date FROM digital_po_date_changes fact WHERE fact.line_id=po.line_id AND fact.date_kind='factory'
      AND fact.created_at<=at_time ORDER BY fact.version DESC LIMIT 1) END) INTO earliest
  FROM digital_production_child_lines child JOIN digital_production_po_lines po USING(production_order_id,line_id)
  WHERE child.module='sourcing' AND child.child_id=case_id;
  IF earliest IS NOT NULL THEN RETURN earliest; END IF;
  SELECT content.content->>'deliveryDate' INTO edited
  FROM sourcing_contract_documents document LEFT JOIN sourcing_contract_content_overrides content USING(sourcing_contract_document_id)
  WHERE document.sourcing_case_id=case_id AND (at_time IS NULL OR document.prepared_at<=at_time)
  ORDER BY document.contract_version DESC LIMIT 1;
  IF edited IS NULL OR edited !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN RETURN fallback_date; END IF;
  RETURN edited::date;
EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN RETURN fallback_date;
END $$;

CREATE OR REPLACE FUNCTION sourcing_contract_content_for_factory_change(document_id uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT old_content.content || jsonb_build_object(
    'partyBName',effective_content.snapshot->>'contractEntityName','partyBAddress',effective_content.snapshot->>'address',
    'partyBRepresentative',effective_content.snapshot->>'partyBRepresentative','payeeName',effective_content.snapshot->>'payeeName',
    'bankAccount',effective_content.snapshot->>'bankAccount','bankName',effective_content.snapshot->>'bankName',
    'totalQuantity',(effective_content.snapshot->>'quantity')::integer,'totalAmount',effective_content.snapshot->'totalAmount',
    'lines',(SELECT jsonb_agg(COALESCE(manual.value,line.value) || jsonb_build_object(
        'quantity',line.value->'quantity','unitPrice',line.value->'unitPrice','totalAmount',line.value->'totalAmount')
        || CASE WHEN line.value ? 'lineId' AND line.value ? 'deliveryDate'
          THEN jsonb_build_object('lineId',line.value->'lineId','deliveryDate',line.value->'deliveryDate') ELSE '{}'::jsonb END
        ORDER BY (line.value->>'position')::integer)
      FROM jsonb_array_elements(effective_content.snapshot->'lines') line(value)
      LEFT JOIN LATERAL (SELECT value FROM jsonb_array_elements(old_content.content->'lines')
        WHERE value->'position'=line.value->'position') manual ON true))
  FROM sourcing_contract_documents document
  JOIN sourcing_contract_documents previous ON previous.sourcing_contract_document_id=document.revision_of
  JOIN sourcing_contract_content_overrides old_content ON old_content.sourcing_contract_document_id=previous.sourcing_contract_document_id
  CROSS JOIN LATERAL (SELECT document.approval_snapshot || COALESCE((SELECT jsonb_object_agg(field_name,field_value)
    FROM sourcing_contract_supplements WHERE sourcing_contract_document_id=document.sourcing_contract_document_id),'{}'::jsonb) AS snapshot) effective_content
  WHERE document.sourcing_contract_document_id=document_id;
$$;

CREATE FUNCTION guard_sourcing_contract_po_dates() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE case_id uuid; item jsonb; current_date_value date;
BEGIN
  SELECT sourcing_case_id INTO case_id FROM sourcing_contract_documents WHERE sourcing_contract_document_id=NEW.sourcing_contract_document_id;
  FOR item IN SELECT value FROM jsonb_array_elements(NEW.content->'lines') LOOP
    IF item ? 'lineId' THEN
      SELECT po.factory_delivery_date INTO current_date_value FROM digital_production_child_lines child
        JOIN digital_production_po_lines po USING(production_order_id,line_id)
        WHERE child.module='sourcing' AND child.child_id=case_id AND po.line_id=(item->>'lineId')::uuid;
      IF NOT FOUND OR item->>'deliveryDate' IS DISTINCT FROM current_date_value::text THEN
        RAISE EXCEPTION 'contract PO date must freeze its own effective factory promise' USING ERRCODE='23514';
      END IF;
    END IF;
  END LOOP;
  RETURN NEW;
END $$;
CREATE TRIGGER sourcing_contract_po_dates_guard BEFORE INSERT ON sourcing_contract_content_overrides
 FOR EACH ROW EXECUTE FUNCTION guard_sourcing_contract_po_dates();
