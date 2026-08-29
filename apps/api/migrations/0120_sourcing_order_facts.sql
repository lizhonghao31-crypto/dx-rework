ALTER TABLE sourcing_cases
  ADD COLUMN delivery_date date,
  ADD COLUMN process_description text
    CHECK(
      process_description IS NULL
      OR length(btrim(process_description)) BETWEEN 1 AND 500
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
    sourcing_case.process_description
  FROM sourcing_cases sourcing_case
  JOIN LATERAL (
    SELECT transition_row.to_status,transition_row.sequence,transition_row.transitioned_at
    FROM sourcing_case_transitions transition_row
    WHERE transition_row.sourcing_case_id=sourcing_case.sourcing_case_id
    ORDER BY transition_row.sequence DESC
    LIMIT 1
  ) current_transition ON true;
