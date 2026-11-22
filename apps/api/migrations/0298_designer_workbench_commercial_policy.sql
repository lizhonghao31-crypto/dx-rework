-- Stamp the policy only on roots born after this migration. An older source
-- keeps its original quotation authority when it later becomes a formal order.
ALTER TABLE digital_production_sources
 ADD COLUMN workbench_commercial_policy text CHECK (workbench_commercial_policy = 'designer_quote_v1');
ALTER TABLE digital_production_sources
 ALTER COLUMN workbench_commercial_policy SET DEFAULT 'designer_quote_v1';
ALTER TABLE digital_commercial_order_rules
 ADD COLUMN workbench_commercial_policy text CHECK (workbench_commercial_policy = 'designer_quote_v1');

-- Preserve the original quote_v1 enrolment and its frozen budget protections.
-- A later attachment of a source does not change this immutable order record.
CREATE OR REPLACE FUNCTION enrol_customer_quotation_policy() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO digital_commercial_order_rules(production_order_id,adopted_by,workbench_commercial_policy)
 VALUES(NEW.production_order_id,NEW.created_by,
   CASE WHEN NEW.source_id IS NULL THEN 'designer_quote_v1' ELSE (
     SELECT s.workbench_commercial_policy FROM digital_production_sources s WHERE s.source_id=NEW.source_id
   ) END);
 RETURN NEW;
END $$;
