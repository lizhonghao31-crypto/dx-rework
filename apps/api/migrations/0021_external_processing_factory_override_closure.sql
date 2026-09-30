-- PR-11 second bounded review closure: selecting any external processing
-- factory for an order whose original processing source is not a supplier
-- (including own-factory orders) is an audited override and requires a reason.

CREATE OR REPLACE FUNCTION guard_external_case_own_factory_override_reason()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  original_processing_factory_type text;
BEGIN
  IF NEW.responsibility_type<>'processing_factory' THEN
    RETURN NEW;
  END IF;

  SELECT processing_factory_type
    INTO original_processing_factory_type
  FROM rework_orders
  WHERE rework_order_id=NEW.rework_order_id;

  IF original_processing_factory_type IS DISTINCT FROM 'supplier'
     AND NEW.processing_factory_override_reason IS NULL THEN
    RAISE EXCEPTION
      'external processing factory selected for non-supplier order requires override reason'
      USING ERRCODE='23514';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER aaa_external_case_own_factory_override_reason
  BEFORE INSERT ON rework_external_responsibility_cases
  FOR EACH ROW
  EXECUTE FUNCTION guard_external_case_own_factory_override_reason();
