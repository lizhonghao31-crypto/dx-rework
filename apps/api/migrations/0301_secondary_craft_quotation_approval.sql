CREATE TABLE digital_secondary_craft_quote_revisions (
  revision_id uuid NOT NULL UNIQUE,
  quote_id uuid NOT NULL REFERENCES digital_quotation_documents(quote_id),
  row_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  round_number integer NOT NULL CHECK (round_number > 0),
  stage text NOT NULL CHECK (stage IN ('development','bulk')),
  scope_id uuid NOT NULL,
  source_version integer NOT NULL CHECK (source_version > 0),
  basis text NOT NULL CHECK (basis ~ '^[0-9a-f]{64}$'),
  author_id uuid NOT NULL REFERENCES app_users(id),
  submitted boolean NOT NULL,
  approver_id uuid REFERENCES app_users(id),
  supplier_id uuid REFERENCES supplier_catalog_items(supplier_id),
  supplier_version integer,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  requirement jsonb NOT NULL CHECK (jsonb_typeof(requirement) = 'object'),
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (quote_id,row_id,revision),
  UNIQUE (quote_id,row_id,revision,approver_id),
  FOREIGN KEY (supplier_id,supplier_version) REFERENCES supplier_catalog_versions(supplier_id,version) MATCH FULL,
  CHECK (submitted = (approver_id IS NOT NULL))
);

CREATE TABLE digital_secondary_craft_quote_decisions (
  decision_id uuid PRIMARY KEY,
  quote_id uuid NOT NULL,
  row_id uuid NOT NULL,
  revision integer NOT NULL,
  actor_id uuid NOT NULL,
  decision text NOT NULL CHECK (decision IN ('approved','returned')),
  reason text NOT NULL CHECK (length(reason) <= 500 AND (decision <> 'returned' OR length(btrim(reason)) > 0)),
  decided_at timestamptz NOT NULL,
  UNIQUE (quote_id,row_id,revision),
  FOREIGN KEY (quote_id,row_id,revision,actor_id)
    REFERENCES digital_secondary_craft_quote_revisions(quote_id,row_id,revision,approver_id)
);

CREATE TRIGGER digital_secondary_craft_revisions_immutable
  BEFORE UPDATE OR DELETE ON digital_secondary_craft_quote_revisions
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER digital_secondary_craft_decisions_immutable
  BEFORE UPDATE OR DELETE ON digital_secondary_craft_quote_decisions
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();

CREATE FUNCTION guard_secondary_craft_approver() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE approver uuid;
BEGIN
  IF TG_TABLE_NAME='digital_secondary_craft_quote_revisions' AND NOT (to_jsonb(NEW)->>'submitted')::boolean THEN RETURN NEW; END IF;
  approver:=coalesce(to_jsonb(NEW)->>'approver_id',to_jsonb(NEW)->>'actor_id')::uuid;
  PERFORM pg_advisory_xact_lock_shared(hashtext('dx_rework:owner_group_guard'));
  IF NOT EXISTS (SELECT 1 FROM business_module_owner_bindings b
    JOIN app_users u ON u.id=b.user_id AND u.enabled AND NOT u.manual_access_disabled
    JOIN access_security_policy p ON p.policy_key='primary'
    JOIN identity_mappings i ON i.user_id=u.id AND i.provider='dingtalk' AND i.corp_id=p.dingtalk_corp_id AND i.active AND i.employed
    JOIN user_role_assignments a ON a.user_id=u.id AND a.role_code='owner_group' AND a.revoked_at IS NULL
    JOIN business_roles r ON r.role_code=a.role_code AND r.enabled
    WHERE b.member_key='wu_yunfeng' AND u.id=approver AND NOT access_is_root_actor(u.id))
  THEN RAISE EXCEPTION 'secondary craft approval requires the bound active member' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER secondary_craft_revision_approver BEFORE INSERT ON digital_secondary_craft_quote_revisions
  FOR EACH ROW EXECUTE FUNCTION guard_secondary_craft_approver();
CREATE TRIGGER secondary_craft_decision_approver BEFORE INSERT ON digital_secondary_craft_quote_decisions
  FOR EACH ROW EXECUTE FUNCTION guard_secondary_craft_approver();

CREATE FUNCTION guard_secondary_craft_approval_notification() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM digital_production_notification_events e
    WHERE e.event_id=NEW.event_id AND e.event_kind='secondary_craft_approval'
    AND NOT EXISTS (SELECT 1 FROM digital_secondary_craft_quote_revisions r
      WHERE r.revision_id=e.todo_id AND r.submitted AND r.approver_id=NEW.recipient_id))
  THEN RAISE EXCEPTION 'secondary craft notification must target its recorded approver' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER secondary_craft_notification_scope BEFORE INSERT ON digital_production_notification_receipts
  FOR EACH ROW EXECUTE FUNCTION guard_secondary_craft_approval_notification();

ALTER TABLE digital_quotation_versions ADD COLUMN secondary_craft_approvals jsonb
  CHECK (secondary_craft_approvals IS NULL OR jsonb_typeof(secondary_craft_approvals) = 'array');
