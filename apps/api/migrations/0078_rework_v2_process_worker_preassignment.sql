-- PR-03: merge process configuration and worker assignment for new configurations.
-- Existing configurations remain legacy-compatible; only configurations created
-- after this migration require a worker preassignment before IE submission.

ALTER TABLE rework_process_configurations
  ADD COLUMN worker_preassignment_required boolean NOT NULL DEFAULT false;
ALTER TABLE rework_process_configurations
  ALTER COLUMN worker_preassignment_required SET DEFAULT true;

CREATE TABLE rework_process_worker_plans (
  plan_id uuid PRIMARY KEY,
  rework_order_id uuid NOT NULL REFERENCES rework_orders(rework_order_id),
  configuration_id uuid NOT NULL UNIQUE REFERENCES rework_process_configurations(configuration_id),
  configuration_version integer NOT NULL CHECK (configuration_version > 0),
  planned_by uuid NOT NULL REFERENCES app_users(id),
  operation_event_id uuid NOT NULL REFERENCES operation_events(event_id),
  request_id text NOT NULL CHECK (request_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX rework_process_worker_plans_order_idx
  ON rework_process_worker_plans(rework_order_id,configuration_version DESC);

CREATE TABLE rework_process_worker_plan_members (
  plan_member_id uuid PRIMARY KEY,
  plan_id uuid NOT NULL REFERENCES rework_process_worker_plans(plan_id),
  configuration_item_id uuid NOT NULL REFERENCES rework_process_configuration_items(configuration_item_id),
  person_id uuid NOT NULL REFERENCES business_people(person_id),
  display_name_snapshot text NOT NULL CHECK (length(btrim(display_name_snapshot)) BETWEEN 1 AND 100),
  person_type_snapshot text NOT NULL CHECK (person_type_snapshot IN ('internal','temporary')),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(plan_id,configuration_item_id,person_id)
);
CREATE INDEX rework_process_worker_plan_members_item_idx
  ON rework_process_worker_plan_members(configuration_item_id,person_id);

CREATE OR REPLACE FUNCTION guard_process_worker_plan_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM rework_process_configurations configuration
    JOIN operation_events event
      ON event.event_id=NEW.operation_event_id
     AND event.request_id=NEW.request_id
     AND event.actor_id=NEW.planned_by
     AND event.actor_roles=access_authorized_actor_roles(NEW.planned_by,'work:assign')
     AND event.authorization_capability='work:assign'
     AND event.action='rework.process_worker_plan.save'
     AND event.entity_type='rework_order'
     AND event.entity_id=NEW.rework_order_id::text
    WHERE configuration.configuration_id=NEW.configuration_id
      AND configuration.rework_order_id=NEW.rework_order_id
      AND configuration.configuration_version=NEW.configuration_version
      AND configuration.status='draft'
      AND configuration.worker_preassignment_required=true
      AND NEW.operation_event_id=nullif(current_setting('dx_rework.process_worker_plan_event_id',true),'')::uuid
      AND NEW.request_id=nullif(current_setting('dx_rework.process_worker_plan_request_id',true),'')
  ) THEN
    RAISE EXCEPTION 'process worker plan requires an authorized draft configuration'
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER rework_process_worker_plans_guard_insert
  BEFORE INSERT ON rework_process_worker_plans
  FOR EACH ROW EXECUTE FUNCTION guard_process_worker_plan_insert();
CREATE TRIGGER rework_process_worker_plans_no_update
  BEFORE UPDATE ON rework_process_worker_plans
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER rework_process_worker_plans_no_delete
  BEFORE DELETE ON rework_process_worker_plans
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();

CREATE OR REPLACE FUNCTION guard_process_worker_plan_member_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM rework_process_worker_plans plan
    JOIN rework_process_configurations configuration
      ON configuration.configuration_id=plan.configuration_id
    JOIN rework_process_configuration_items item
      ON item.configuration_id=configuration.configuration_id
     AND item.configuration_item_id=NEW.configuration_item_id
    WHERE plan.plan_id=NEW.plan_id
      AND plan.operation_event_id=nullif(current_setting('dx_rework.process_worker_plan_event_id',true),'')::uuid
      AND plan.request_id=nullif(current_setting('dx_rework.process_worker_plan_request_id',true),'')
  ) THEN
    RAISE EXCEPTION 'process worker plan member must belong to the audited configuration'
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER rework_process_worker_plan_members_guard_insert
  BEFORE INSERT ON rework_process_worker_plan_members
  FOR EACH ROW EXECUTE FUNCTION guard_process_worker_plan_member_insert();
CREATE TRIGGER rework_process_worker_plan_members_no_update
  BEFORE UPDATE ON rework_process_worker_plan_members
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER rework_process_worker_plan_members_no_delete
  BEFORE DELETE ON rework_process_worker_plan_members
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
