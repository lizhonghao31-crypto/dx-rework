-- Preserve the legacy process description for compatibility and search while
-- storing new sourcing orders as an ordered, independently editable process list.

CREATE OR REPLACE FUNCTION sourcing_process_items_valid(items text[])
RETURNS boolean LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT cardinality(items) BETWEEN 1 AND 20
    AND NOT EXISTS (
      SELECT 1
      FROM unnest(items) item
      WHERE item IS NULL OR length(btrim(item)) NOT BETWEEN 1 AND 100
    )
    AND cardinality(items)=(SELECT count(DISTINCT item) FROM unnest(items) item)
$$;

ALTER TABLE sourcing_cases
  ADD COLUMN process_items text[],
  DROP CONSTRAINT sourcing_cases_process_description_check,
  ADD CONSTRAINT sourcing_cases_process_description_check CHECK(
    process_description IS NULL
    OR length(btrim(process_description)) BETWEEN 1 AND 2100
  ),
  ADD CONSTRAINT sourcing_cases_process_items_check CHECK(
    process_items IS NULL OR sourcing_process_items_valid(process_items)
  );

CREATE OR REPLACE VIEW current_sourcing_cases AS
  SELECT
    sourcing_case.sourcing_case_id,
    sourcing_case.erp_order_id,
    sourcing_case.erp_order_no,
    sourcing_case.style_no,
    sourcing_case.lane_key,
    sourcing_case.order_quantity,
    current_transition.to_status AS status,
    current_transition.sequence AS version,
    sourcing_case.created_by,
    sourcing_case.created_at,
    current_transition.transitioned_at AS updated_at,
    sourcing_case.delivery_date,
    sourcing_case.process_description,
    sourcing_case.process_items
  FROM sourcing_cases sourcing_case
  JOIN LATERAL (
    SELECT transition_row.to_status,transition_row.sequence,transition_row.transitioned_at
    FROM sourcing_case_transitions transition_row
    WHERE transition_row.sourcing_case_id=sourcing_case.sourcing_case_id
    ORDER BY transition_row.sequence DESC
    LIMIT 1
  ) current_transition ON true
  WHERE sourcing_case.deleted_at IS NULL;
