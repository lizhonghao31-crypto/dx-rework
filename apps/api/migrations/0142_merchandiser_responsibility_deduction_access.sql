-- Scope merchandiser deduction handling to orders explicitly assigned to them.
DROP TRIGGER IF EXISTS role_capabilities_no_insert ON role_capabilities;

INSERT INTO role_capabilities(role_code,capability) VALUES
  ('order_merchandiser','external_deduction:record'),
  ('order_merchandiser','external_deduction:close'),
  ('embroidery_washing_merchandiser','external_deduction:record'),
  ('embroidery_washing_merchandiser','external_deduction:close')
ON CONFLICT DO NOTHING;

CREATE TRIGGER role_capabilities_no_insert
  BEFORE INSERT ON role_capabilities FOR EACH ROW
  EXECUTE FUNCTION reject_operation_event_mutation();

CREATE OR REPLACE FUNCTION external_responsibility_assigned_merchandiser(
  candidate uuid, order_id uuid, responsibility_type_value text,
  required_capability text
) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN responsibility_type_value IN ('processing_factory','fabric_supplier') THEN
      EXISTS (
        SELECT 1 FROM rework_orders order_record
        WHERE order_record.rework_order_id=order_id
          AND order_record.merchandiser_user_id=candidate
          AND responsibility_actor_has_direct_role(
            candidate,required_capability,ARRAY['order_merchandiser']
          )
      )
    WHEN responsibility_type_value IN ('embroidery_factory','washing_factory') THEN
      EXISTS (
        SELECT 1 FROM rework_order_supply_context supply
        WHERE supply.rework_order_id=order_id
          AND supply.embroidery_merchandiser_user_id=candidate
          AND responsibility_actor_has_direct_role(
            candidate,required_capability,
            ARRAY['embroidery_washing_merchandiser']
          )
      )
    ELSE false
  END
$$;

CREATE OR REPLACE FUNCTION external_responsibility_can_sign(
  candidate uuid, order_id uuid, responsibility_type_value text
) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT access_is_root_actor(candidate)
    OR external_responsibility_assigned_merchandiser(
      candidate,order_id,responsibility_type_value,
      'external_responsibility:sign'
    )
    OR CASE
      WHEN responsibility_type_value IN ('processing_factory','fabric_supplier') THEN
        external_responsibility_active_delegation(
          candidate,'external_responsibility:sign',order_id,
          ARRAY['order_merchandiser']
        )
      WHEN responsibility_type_value IN ('embroidery_factory','washing_factory') THEN
        external_responsibility_active_delegation(
          candidate,'external_responsibility:sign',order_id,
          ARRAY['embroidery_washing_merchandiser']
        )
      ELSE false
    END
$$;

CREATE OR REPLACE FUNCTION external_responsibility_can_payables(
  candidate uuid, order_id uuid, responsibility_type_value text,
  required_capability text
) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT access_is_root_actor(candidate)
    OR CASE responsibility_type_value
      WHEN 'processing_factory' THEN
        responsibility_actor_has_direct_role(
          candidate,required_capability,ARRAY['factory_payables']
        ) OR external_responsibility_active_delegation(
          candidate,required_capability,order_id,ARRAY['factory_payables']
        )
      WHEN 'fabric_supplier' THEN
        responsibility_actor_has_direct_role(
          candidate,required_capability,ARRAY['fabric_payables']
        ) OR external_responsibility_active_delegation(
          candidate,required_capability,order_id,ARRAY['fabric_payables']
        )
      WHEN 'embroidery_factory' THEN
        responsibility_actor_has_direct_role(
          candidate,required_capability,ARRAY['embroidery_washing_payables']
        ) OR external_responsibility_active_delegation(
          candidate,required_capability,order_id,
          ARRAY['embroidery_washing_payables']
        )
      WHEN 'washing_factory' THEN
        responsibility_actor_has_direct_role(
          candidate,required_capability,ARRAY['embroidery_washing_payables']
        ) OR external_responsibility_active_delegation(
          candidate,required_capability,order_id,
          ARRAY['embroidery_washing_payables']
        )
      ELSE false
    END
    OR (
      required_capability=ANY(ARRAY[
        'external_deduction:follow_up',
        'external_deduction:record',
        'external_deduction:close'
      ])
      AND external_responsibility_assigned_merchandiser(
        candidate,order_id,responsibility_type_value,required_capability
      )
    )
$$;

CREATE OR REPLACE FUNCTION external_responsibility_can_payables(
  candidate uuid, order_id uuid, responsibility_type_value text
) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT external_responsibility_can_payables(
           candidate,order_id,responsibility_type_value,
           'external_responsibility:payables_confirm')
      OR external_responsibility_can_payables(
           candidate,order_id,responsibility_type_value,
           'external_deduction:follow_up')
      OR external_responsibility_can_payables(
           candidate,order_id,responsibility_type_value,
           'external_deduction:record')
      OR external_responsibility_can_payables(
           candidate,order_id,responsibility_type_value,
           'external_deduction:close')
$$;
