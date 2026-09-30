-- Node one records quantities and budget only. Existing quotes remain unchanged.
ALTER TABLE sourcing_case_lines DROP CONSTRAINT sourcing_case_lines_check;
ALTER TABLE sourcing_case_lines ADD CONSTRAINT sourcing_case_lines_color_required
  CHECK (legacy_source OR color IS NOT NULL);

ALTER TABLE sourcing_decisions
  ADD COLUMN cutting_process text CHECK (cutting_process IN ('in_house','outsourced','other')),
  ADD COLUMN cutting_process_other text,
  ADD CONSTRAINT sourcing_decisions_cutting_details CHECK (
    (cutting_process IS DISTINCT FROM 'other' AND cutting_process_other IS NULL)
    OR (cutting_process='other' AND cutting_process_other IS NOT NULL
        AND length(btrim(cutting_process_other)) BETWEEN 1 AND 100)
  );

-- Keep the new internal facts audited; existing decision immutability still applies.
CREATE FUNCTION guard_sourcing_cutting_process() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected_kind text; expected_other text;
BEGIN
  IF NEW.source_type='factory_change' THEN
    SELECT cutting_process,cutting_process_other INTO expected_kind,expected_other
    FROM sourcing_decisions WHERE sourcing_decision_id=NEW.supersedes_decision_id;
  ELSE
    SELECT after_state->>'cuttingProcess',after_state->>'cuttingProcessOther'
    INTO expected_kind,expected_other FROM operation_events WHERE event_id=NEW.operation_event_id;
  END IF;
  IF NEW.cutting_process IS DISTINCT FROM expected_kind
     OR NEW.cutting_process_other IS DISTINCT FROM expected_other THEN
    RAISE EXCEPTION 'cutting process must match management audit or previous decision' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER sourcing_decisions_guard_cutting BEFORE INSERT ON sourcing_decisions
  FOR EACH ROW EXECUTE FUNCTION guard_sourcing_cutting_process();
-- Forward correction only. Historical prices and NULL cutting facts are not backfilled.
