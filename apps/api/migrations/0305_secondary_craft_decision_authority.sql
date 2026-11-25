-- Keep every decision bound to the original submitted revision. Its actual
-- decision maker can now differ from the notification recipient.
ALTER TABLE digital_secondary_craft_quote_decisions ADD COLUMN approval_authority text
  CHECK (approval_authority IN ('root_superuser','bound_wu_yunfeng'));

DO $$
DECLARE prior_fk name;
BEGIN
  SELECT conname INTO STRICT prior_fk FROM pg_constraint
    WHERE conrelid='digital_secondary_craft_quote_decisions'::regclass
      AND confrelid='digital_secondary_craft_quote_revisions'::regclass AND contype='f';
  EXECUTE format('ALTER TABLE digital_secondary_craft_quote_decisions DROP CONSTRAINT %I',prior_fk);
END $$;

ALTER TABLE digital_secondary_craft_quote_decisions
  ADD CONSTRAINT secondary_craft_decision_revision_fk FOREIGN KEY (quote_id,row_id,revision)
    REFERENCES digital_secondary_craft_quote_revisions(quote_id,row_id,revision),
  ADD CONSTRAINT secondary_craft_decision_actor_fk FOREIGN KEY (actor_id) REFERENCES app_users(id);

CREATE OR REPLACE FUNCTION guard_secondary_craft_approver() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE approver uuid;
DECLARE recipient uuid;
DECLARE canonical_root uuid;
BEGIN
  IF TG_TABLE_NAME='digital_secondary_craft_quote_revisions' AND NOT (to_jsonb(NEW)->>'submitted')::boolean THEN RETURN NEW; END IF;
  approver:=coalesce(to_jsonb(NEW)->>'approver_id',to_jsonb(NEW)->>'actor_id')::uuid;
  PERFORM pg_advisory_xact_lock_shared(hashtext('dx_rework:owner_group_guard'));
  IF TG_TABLE_NAME='digital_secondary_craft_quote_decisions' THEN
    SELECT r.approver_id INTO recipient FROM digital_secondary_craft_quote_revisions r
      WHERE (r.quote_id,r.row_id,r.revision)=(NEW.quote_id,NEW.row_id,NEW.revision) AND r.submitted;
    IF recipient IS NULL THEN
      RAISE EXCEPTION 'secondary craft approval requires the submitted revision' USING ERRCODE='23514';
    END IF;
  END IF;

  IF access_is_root_actor(approver) AND EXISTS (SELECT 1 FROM app_users u WHERE u.id=approver AND NOT u.manual_access_disabled) THEN
    IF TG_TABLE_NAME='digital_secondary_craft_quote_decisions' THEN NEW.approval_authority:='root_superuser'; END IF;
    RETURN NEW;
  END IF;

  SELECT user_id INTO canonical_root FROM owner_bootstrap_consumptions WHERE singleton;
  IF (TG_TABLE_NAME='digital_secondary_craft_quote_decisions' AND recipient<>approver AND recipient IS DISTINCT FROM canonical_root)
    OR NOT EXISTS (SELECT 1 FROM business_module_owner_bindings b
      JOIN app_users u ON u.id=b.user_id AND u.enabled AND NOT u.manual_access_disabled
      JOIN access_security_policy p ON p.policy_key='primary'
      JOIN identity_mappings i ON i.user_id=u.id AND i.provider='dingtalk' AND i.corp_id=p.dingtalk_corp_id AND i.active AND i.employed
      JOIN user_role_assignments a ON a.user_id=u.id AND a.role_code='owner_group' AND a.revoked_at IS NULL
      JOIN business_roles r ON r.role_code=a.role_code AND r.enabled
      WHERE b.member_key='wu_yunfeng' AND u.id=approver AND NOT access_is_root_actor(u.id))
  THEN RAISE EXCEPTION 'secondary craft approval requires the bound active member or Root' USING ERRCODE='23514';
  END IF;
  IF TG_TABLE_NAME='digital_secondary_craft_quote_decisions' THEN NEW.approval_authority:='bound_wu_yunfeng'; END IF;
  RETURN NEW;
END
$$;
