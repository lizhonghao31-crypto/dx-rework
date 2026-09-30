-- Current displays follow the contract revision; original order/approval/dispatch facts remain immutable.
CREATE FUNCTION sourcing_contract_display_number(document_id uuid, fallback_number text)
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT COALESCE((SELECT content->>'contractNumber' FROM sourcing_contract_content_overrides
    WHERE sourcing_contract_document_id=document_id),fallback_number)
$$;

CREATE FUNCTION sourcing_effective_delivery_date(case_id uuid, fallback_date date, at_time timestamptz DEFAULT NULL)
RETURNS date LANGUAGE plpgsql STABLE AS $$
DECLARE edited text;
BEGIN
  SELECT content.content->>'deliveryDate' INTO edited
  FROM sourcing_contract_documents document
  LEFT JOIN sourcing_contract_content_overrides content USING(sourcing_contract_document_id)
  WHERE document.sourcing_case_id=case_id AND (at_time IS NULL OR document.prepared_at<=at_time)
  ORDER BY document.contract_version DESC LIMIT 1;
  -- Legacy free-text contracts must not break order lists or historical reads.
  IF edited IS NULL OR edited !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN RETURN fallback_date; END IF;
  RETURN edited::date;
EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
  RETURN fallback_date;
END $$;
