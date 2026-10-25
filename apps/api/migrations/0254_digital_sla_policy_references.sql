-- Preserve existing immutable publications and the old reader shape. New writers resolve
-- standards from original deadline-policy versions; values_json is a compatibility snapshot.
ALTER TABLE digital_sla_configurations ADD COLUMN policy_refs_json jsonb
 CHECK(policy_refs_json IS NULL OR (jsonb_typeof(policy_refs_json)='object'
   AND policy_refs_json->>'storage'='policy_refs_v1'));
COMMENT ON COLUMN digital_sla_configurations.policy_refs_json IS
 'Authoritative policy-version references and parameters not expressible by the original duration policy. Null on historical publications.';
COMMENT ON COLUMN digital_sla_configurations.values_json IS
 'Immutable resolved compatibility snapshot. New code reads policy_refs_json when present; no independent edit or synchronization path.';

-- An old application may read the compatibility snapshot after rollback, but must not
-- resume the old unpreviewed writer for parameters already adopted by unified publishing.
CREATE FUNCTION guard_digital_sla_policy_publication() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.version>1 AND current_setting('dx.sla_policy_publication',true) IS DISTINCT FROM 'on'
   AND EXISTS(SELECT 1 FROM digital_sla_configurations c,
     LATERAL jsonb_each(c.policy_refs_json->'policies') ref
     WHERE ref.value->>'nodeKey'=NEW.node_key) THEN
   RAISE EXCEPTION 'SLA policy requires unified publication; legacy rollback configuration is read-only'
     USING ERRCODE='55000';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER digital_sla_policy_publication_guard BEFORE INSERT ON digital_production_deadline_policies
FOR EACH ROW EXECUTE FUNCTION guard_digital_sla_policy_publication();
