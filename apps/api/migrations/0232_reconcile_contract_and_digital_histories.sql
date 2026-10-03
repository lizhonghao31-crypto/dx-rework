-- Both original branch histories must be applied under their original identities.
-- This final marker forces deployment/backup code to recognize the unified schema
-- as a forward migration even when an Acceptance database already reached 0231.
DO $$
BEGIN
  IF to_regclass('sourcing_contract_content_overrides') IS NULL
     OR to_regprocedure('sourcing_effective_delivery_date(uuid,date,timestamp with time zone)') IS NULL
     OR to_regclass('digital_order_closures') IS NULL THEN
    RAISE EXCEPTION 'Both contract and digital production schemas are required before reconciliation';
  END IF;
END $$;
