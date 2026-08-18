-- Root bypass for external responsibility is deliberately limited to the one
-- immutable Root identity. All non-Root SQL authorization remains unchanged.
CREATE OR REPLACE FUNCTION external_responsibility_direct_role(
  candidate uuid, required_capability text, allowed_roles text[]
) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT access_is_root_actor(candidate)
    OR responsibility_actor_has_direct_role(candidate,required_capability,allowed_roles)
$$;

CREATE OR REPLACE FUNCTION external_responsibility_can_sign(
  candidate uuid, order_id uuid, responsibility_type text
) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT access_is_root_actor(candidate)
    OR CASE
      WHEN responsibility_type IN ('processing_factory','fabric_supplier') THEN
        EXISTS (
          SELECT 1
          FROM rework_orders order_record
          WHERE order_record.rework_order_id=order_id
            AND order_record.merchandiser_user_id=candidate
            AND external_responsibility_direct_role(
              candidate,'external_responsibility:sign',ARRAY['order_merchandiser']
            )
        ) OR external_responsibility_active_delegation(
          candidate,'external_responsibility:sign',order_id,ARRAY['order_merchandiser']
        )
      WHEN responsibility_type IN ('embroidery_factory','washing_factory') THEN
        external_responsibility_direct_role(
          candidate,'external_responsibility:sign',ARRAY['embroidery_washing_merchandiser']
        ) OR external_responsibility_active_delegation(
          candidate,'external_responsibility:sign',order_id,
          ARRAY['embroidery_washing_merchandiser']
        )
      ELSE false
    END
$$;

CREATE OR REPLACE FUNCTION external_responsibility_can_payables(
  candidate uuid, order_id uuid, responsibility_type text
) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT access_is_root_actor(candidate)
    OR CASE responsibility_type
      WHEN 'processing_factory' THEN
        external_responsibility_direct_role(candidate,'external_responsibility:payables_confirm',ARRAY['factory_payables'])
        OR external_responsibility_active_delegation(candidate,'external_responsibility:payables_confirm',order_id,ARRAY['factory_payables'])
      WHEN 'fabric_supplier' THEN
        external_responsibility_direct_role(candidate,'external_responsibility:payables_confirm',ARRAY['fabric_payables'])
        OR external_responsibility_active_delegation(candidate,'external_responsibility:payables_confirm',order_id,ARRAY['fabric_payables'])
      WHEN 'embroidery_factory' THEN
        external_responsibility_direct_role(candidate,'external_responsibility:payables_confirm',ARRAY['embroidery_washing_payables'])
        OR external_responsibility_active_delegation(candidate,'external_responsibility:payables_confirm',order_id,ARRAY['embroidery_washing_payables'])
      WHEN 'washing_factory' THEN
        external_responsibility_direct_role(candidate,'external_responsibility:payables_confirm',ARRAY['embroidery_washing_payables'])
        OR external_responsibility_active_delegation(candidate,'external_responsibility:payables_confirm',order_id,ARRAY['embroidery_washing_payables'])
      ELSE false
    END
$$;

CREATE OR REPLACE FUNCTION external_responsibility_can_view_all(candidate uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT access_is_root_actor(candidate)
    OR external_responsibility_direct_role(
      candidate,'external_responsibility:view',
      ARRAY['production_management','owner_group','tail_supervisor','finance_read']
    )
$$;
