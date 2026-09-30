-- UAT 1.6: a merchandiser may create a missing supplier only while
-- handling an authorized active external-responsibility item. The supplier
-- stays in the catalog, but creation is bound to the rework order and audited
-- as external-responsibility work rather than generic master-data maintenance.

CREATE OR REPLACE FUNCTION guard_supplier_catalog_version_creation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  audit_event_id text := nullif(current_setting('dx_rework.supplier_version_event_id', true), '');
  audit_request_id text := nullif(current_setting('dx_rework.supplier_version_request_id', true), '');
  audit_authorization_capability text := COALESCE(
    nullif(current_setting(
      'dx_rework.supplier_version_authorization_capability',
      true
    ), ''),
    'master_data:manage'
  );
  external_supplier_order_id text := nullif(
    current_setting('dx_rework.external_supplier_order_id', true),
    ''
  );
  audit_actor_roles text[];
  previous_version integer;
  previous_supplier_name text;
  previous_active boolean;
  stable_supplier_code text;
  stable_supplier_type text;
  previous_state jsonb;
  audit_action text;
BEGIN
  IF audit_event_id IS NULL OR audit_request_id IS NULL
     OR audit_request_id !~ '^[A-Za-z0-9._:-]{1,128}$'
  THEN
    RAISE EXCEPTION 'supplier catalog version creation requires trusted audit context'
      USING ERRCODE = '55000';
  END IF;
  IF audit_authorization_capability NOT IN (
    'master_data:manage',
    'external_responsibility:sign'
  ) THEN
    RAISE EXCEPTION 'supplier catalog creation capability is invalid'
      USING ERRCODE = '42501';
  END IF;

  IF audit_authorization_capability='external_responsibility:sign' THEN
    -- Order-scoped delegates are valid signers even though they do not hold a
    -- global capability. The per-order authorization is enforced below.
    SELECT array_agg(DISTINCT assignment.role_code ORDER BY assignment.role_code)
    INTO audit_actor_roles
    FROM user_role_assignments assignment
    JOIN business_roles role
      ON role.role_code=assignment.role_code AND role.enabled=true
    JOIN app_users user_record
      ON user_record.id=assignment.user_id AND user_record.enabled=true
    WHERE assignment.user_id=NEW.changed_by
      AND assignment.revoked_at IS NULL
      AND EXISTS (
        SELECT 1
        FROM identity_mappings identity_mapping
        JOIN access_security_policy policy
          ON policy.policy_key='primary'
          AND policy.dingtalk_corp_id=identity_mapping.corp_id
        WHERE identity_mapping.user_id=assignment.user_id
          AND identity_mapping.provider='dingtalk'
          AND identity_mapping.active=true
          AND identity_mapping.employed=true
      );
    IF audit_actor_roles IS NULL THEN
      RAISE EXCEPTION 'supplier catalog creation requires an active business actor'
        USING ERRCODE = '42501';
    END IF;
  ELSE
    audit_actor_roles := access_authorized_actor_roles(
      NEW.changed_by,
      audit_authorization_capability
    );
  END IF;
  SELECT i.supplier_code,i.supplier_type
  INTO stable_supplier_code,stable_supplier_type
  FROM supplier_catalog_items i
  WHERE i.supplier_id=NEW.supplier_id
  FOR UPDATE;
  IF stable_supplier_code IS NULL THEN
    RAISE EXCEPTION 'supplier catalog item does not exist'
      USING ERRCODE = '23503';
  END IF;
  SELECT v.version,v.supplier_name,v.active
  INTO previous_version,previous_supplier_name,previous_active
  FROM supplier_catalog_versions v
  WHERE v.supplier_id=NEW.supplier_id
  ORDER BY v.version DESC
  LIMIT 1;

  IF audit_authorization_capability='external_responsibility:sign' THEN
    IF previous_version IS NOT NULL
       OR external_supplier_order_id IS NULL
       OR NOT EXISTS (
         SELECT 1
         FROM rework_external_responsibility_batches batch
         JOIN rework_external_responsibility_items item
           ON item.batch_id=batch.batch_id
         WHERE batch.rework_order_id=external_supplier_order_id::uuid
           AND batch.status='active'
           AND external_responsibility_expected_supplier_type(
             item.responsibility_type
           )=stable_supplier_type
           AND external_responsibility_can_sign(
             NEW.changed_by,
             batch.rework_order_id,
             item.responsibility_type
           )
       )
    THEN
      RAISE EXCEPTION 'temporary supplier creation is not authorized for this external responsibility'
        USING ERRCODE = '42501';
    END IF;
    IF NEW.version <> 1 THEN
      RAISE EXCEPTION 'temporary supplier first version must be 1'
        USING ERRCODE = '23514';
    END IF;
    previous_state := NULL;
    audit_action := 'rework.external_responsibility.temporary_supplier.create';
  ELSIF previous_version IS NULL THEN
    IF NEW.version <> 1 THEN
      RAISE EXCEPTION 'first supplier catalog version must be 1'
        USING ERRCODE = '23514';
    END IF;
    previous_state := NULL;
    audit_action := 'master_data.supplier.create';
  ELSE
    IF NEW.version <> previous_version + 1 THEN
      RAISE EXCEPTION 'supplier catalog versions must be sequential'
        USING ERRCODE = '23514';
    END IF;
    previous_state := jsonb_build_object(
      'supplierCode',stable_supplier_code,
      'supplierType',stable_supplier_type,
      'version',previous_version,
      'supplierName',previous_supplier_name,
      'active',previous_active
    );
    audit_action := 'master_data.supplier.revise';
  END IF;

  INSERT INTO operation_events(
    event_id,request_id,actor_id,actor_roles,authorization_capability,
    action,entity_type,entity_id,before_state,after_state,reason
  ) VALUES (
    audit_event_id::uuid,audit_request_id,NEW.changed_by,audit_actor_roles,
    audit_authorization_capability,audit_action,'supplier_catalog',
    NEW.supplier_id::text,previous_state,
    jsonb_build_object(
      'supplierCode',stable_supplier_code,
      'supplierType',stable_supplier_type,
      'version',NEW.version,
      'supplierName',NEW.supplier_name,
      'active',NEW.active
    ),
    NEW.change_reason
  );
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION require_supplier_catalog_initial_version()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM supplier_catalog_versions v
    JOIN operation_events e
      ON e.entity_type='supplier_catalog'
      AND e.entity_id=NEW.supplier_id::text
      AND e.actor_id=v.changed_by
      AND e.reason=v.change_reason
      AND (
        (
          e.action='master_data.supplier.create'
          AND e.authorization_capability='master_data:manage'
        )
        OR (
          e.action='rework.external_responsibility.temporary_supplier.create'
          AND e.authorization_capability='external_responsibility:sign'
        )
      )
    WHERE v.supplier_id=NEW.supplier_id AND v.version=1
      AND e.after_state->>'supplierCode'=NEW.supplier_code
      AND e.after_state->>'supplierType'=NEW.supplier_type
      AND (e.after_state->>'version')::integer=1
      AND e.after_state->>'supplierName'=v.supplier_name
      AND (e.after_state->>'active')::boolean=v.active
  ) THEN
    RAISE EXCEPTION 'supplier catalog item requires an authorized audited initial version in the same transaction'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
