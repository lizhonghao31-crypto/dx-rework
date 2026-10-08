-- A new name may be remembered only by a successful, authorized order transfer.
-- Preserve ordinary master-data creation/revision guards. The narrow exception is
-- checked again at transaction commit against the real immutable transfer request.
CREATE OR REPLACE FUNCTION guard_craft_catalog_version_creation()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  audit_event operation_events%ROWTYPE;
  stable_craft_code text;
  previous_version integer;
  previous_craft_name text;
  previous_active boolean;
  previous_state jsonb;
  transfer_creation boolean;
BEGIN
  SELECT craft_code INTO stable_craft_code
  FROM craft_catalog_items
  WHERE craft_id=NEW.craft_id
  FOR UPDATE;
  IF stable_craft_code IS NULL THEN
    RAISE EXCEPTION 'craft catalog item does not exist' USING ERRCODE='23503';
  END IF;

  SELECT * INTO audit_event
  FROM operation_events
  WHERE event_id=NEW.operation_event_id;

  transfer_creation := COALESCE(
    audit_event.after_state ? 'factoryChangeRequestId'
    AND audit_event.after_state ? 'sourcingCaseId'
    AND audit_event.authorization_capability IN (
      'sourcing:factory_change:request','sourcing:decision:record','sourcing:owner:approve'
    ), false);

  SELECT version,craft_name,active
  INTO previous_version,previous_craft_name,previous_active
  FROM craft_catalog_versions
  WHERE craft_id=NEW.craft_id
  ORDER BY version DESC
  LIMIT 1;

  IF previous_version IS NULL THEN
    IF NEW.version<>1 OR audit_event.action<>'master_data.craft.create'
       OR audit_event.before_state IS NOT NULL
       OR (audit_event.authorization_capability NOT IN ('master_data:manage','sourcing:decision:record') AND NOT transfer_creation)
    THEN
      RAISE EXCEPTION 'first craft catalog version requires authorized creation audit'
        USING ERRCODE='55000';
    END IF;
    previous_state := NULL;
  ELSE
    previous_state := jsonb_build_object(
      'craftId',NEW.craft_id,
      'craftCode',stable_craft_code,
      'version',previous_version,
      'craftName',previous_craft_name,
      'active',previous_active
    );
    IF NEW.version<>previous_version+1
       OR audit_event.action<>'master_data.craft.revise'
       OR audit_event.authorization_capability<>'master_data:manage'
       OR audit_event.before_state<>previous_state
    THEN
      RAISE EXCEPTION 'craft catalog versions must be sequential and audited'
        USING ERRCODE='55000';
    END IF;
  END IF;

  IF audit_event.event_id IS NULL
     OR audit_event.request_id<>NEW.request_id
     OR audit_event.actor_id<>NEW.changed_by
     OR audit_event.entity_type<>'craft_catalog'
     OR audit_event.entity_id<>NEW.craft_id::text
     OR audit_event.reason<>NEW.change_reason
     OR audit_event.after_state->>'craftId'<>NEW.craft_id::text
     OR audit_event.after_state->>'craftCode'<>stable_craft_code
     OR (audit_event.after_state->>'version')::integer<>NEW.version
     OR audit_event.after_state->>'craftName'<>NEW.craft_name
     OR (audit_event.after_state->>'active')::boolean<>NEW.active
  THEN
    RAISE EXCEPTION 'craft catalog version requires matching audit event'
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION guard_transfer_craft_creation_commit()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE creation_event operation_events%ROWTYPE;
BEGIN
  SELECT * INTO creation_event FROM operation_events WHERE event_id=NEW.operation_event_id;
  IF NOT (creation_event.after_state ? 'factoryChangeRequestId') THEN RETURN NEW; END IF;
  IF NEW.version<>1 OR NOT NEW.active OR NOT EXISTS (
    SELECT 1
    FROM sourcing_factory_change_requests transfer
    JOIN operation_events request_event ON request_event.event_id=transfer.operation_event_id
    CROSS JOIN LATERAL jsonb_array_elements(request_event.after_state->'crafts') frozen(craft)
    JOIN craft_catalog_items item ON item.craft_id=NEW.craft_id
    WHERE transfer.factory_change_request_id::text=creation_event.after_state->>'factoryChangeRequestId'
      AND transfer.sourcing_case_id::text=creation_event.after_state->>'sourcingCaseId'
      AND transfer.requested_by=NEW.changed_by AND transfer.request_id=NEW.request_id
      AND request_event.actor_id=NEW.changed_by AND request_event.request_id=NEW.request_id
      AND request_event.authorization_capability=creation_event.authorization_capability
      AND request_event.authorization_capability=CASE transfer.initiator_role
        WHEN 'order_merchandiser' THEN 'sourcing:factory_change:request'
        WHEN 'production_management' THEN 'sourcing:decision:record'
        ELSE 'sourcing:owner:approve' END
      AND (transfer.initiator_role=ANY(creation_event.actor_roles) OR 'root_superuser'=ANY(creation_event.actor_roles))
      AND request_event.action IN ('sourcing.factory_change.request','sourcing.factory_change.effective')
      AND request_event.entity_type='sourcing_case'
      AND request_event.entity_id=transfer.sourcing_case_id::text
      AND request_event.after_state->>'factoryChangeRequestId'=transfer.factory_change_request_id::text
      AND frozen.craft->>'craftId'=NEW.craft_id::text
      AND frozen.craft->>'craftCode'=item.craft_code
      AND frozen.craft->>'craftVersion'=NEW.version::text
      AND frozen.craft->>'craftName'=NEW.craft_name
  ) THEN
    RAISE EXCEPTION 'new transfer craft must belong to the same successful order transfer'
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER craft_catalog_versions_transfer_creation_commit
AFTER INSERT ON craft_catalog_versions DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION guard_transfer_craft_creation_commit();
