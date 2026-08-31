-- Sourcing factory-change role metadata.
-- This migration is intentionally backward-compatible: the existing two-role
-- factory-change workflow keeps working until the service transition ships.
ALTER TABLE sourcing_factory_change_requests
  ADD COLUMN initiator_role text NOT NULL DEFAULT 'order_merchandiser'
    CHECK(initiator_role IN (
      'order_merchandiser',
      'production_management',
      'owner_group'
    )),
  ADD COLUMN requires_owner_approval boolean NOT NULL DEFAULT false;

ALTER TABLE sourcing_factory_change_decisions
  ADD COLUMN decision_role text NOT NULL DEFAULT 'production_management'
    CHECK(decision_role IN ('production_management','owner_group'));

-- Existing audit rows receive the policy result implied by their immutable
-- proposal and baseline decision.
ALTER TABLE sourcing_factory_change_requests
  DISABLE TRIGGER sourcing_factory_change_requests_no_update;
UPDATE sourcing_factory_change_requests request_row
SET requires_owner_approval=(
  request_row.proposed_unit_price>baseline.unit_price
)
FROM sourcing_decisions baseline
WHERE baseline.sourcing_decision_id=request_row.from_decision_id;
ALTER TABLE sourcing_factory_change_requests
  ENABLE TRIGGER sourcing_factory_change_requests_no_update;

-- Keep the derived price policy correct for legacy callers during the staged
-- rollout. PR2 will consume this fact but does not need to trust request input.
CREATE OR REPLACE FUNCTION set_sourcing_factory_change_price_policy()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  baseline_unit_price numeric(18,4);
BEGIN
  SELECT decision_row.unit_price
  INTO baseline_unit_price
  FROM sourcing_decisions decision_row
  WHERE decision_row.sourcing_decision_id=NEW.from_decision_id
    AND decision_row.sourcing_case_id=NEW.sourcing_case_id;

  IF baseline_unit_price IS NOT NULL THEN
    NEW.requires_owner_approval :=
      NEW.proposed_unit_price>baseline_unit_price;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sourcing_factory_change_price_policy
  ON sourcing_factory_change_requests;
CREATE TRIGGER sourcing_factory_change_price_policy
  BEFORE INSERT ON sourcing_factory_change_requests
  FOR EACH ROW
  EXECUTE FUNCTION set_sourcing_factory_change_price_policy();
