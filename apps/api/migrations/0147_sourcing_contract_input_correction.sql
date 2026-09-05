-- Contract input correction V1.1; leave existing cases, approvals and PDFs untouched.
CREATE TABLE sourcing_style_catalog (
  style_id uuid PRIMARY KEY,
  style_name text NOT NULL CHECK(length(btrim(style_name)) BETWEEN 1 AND 100),
  normalized_name text GENERATED ALWAYS AS (lower(btrim(style_name))) STORED UNIQUE,
  created_by uuid NOT NULL REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TRIGGER sourcing_style_catalog_no_update BEFORE UPDATE ON sourcing_style_catalog
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER sourcing_style_catalog_no_delete BEFORE DELETE ON sourcing_style_catalog
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER sourcing_style_catalog_no_truncate BEFORE TRUNCATE ON sourcing_style_catalog
  FOR EACH STATEMENT EXECUTE FUNCTION reject_operation_event_mutation();

ALTER TABLE sourcing_cases
  ADD COLUMN gender text CHECK(gender IN ('男装','女装')),
  ADD COLUMN style_id uuid REFERENCES sourcing_style_catalog(style_id),
  ADD COLUMN style_name_snapshot text CHECK(length(btrim(style_name_snapshot)) BETWEEN 1 AND 100),
  ADD CONSTRAINT sourcing_case_classification_complete CHECK(
    (gender IS NULL AND style_id IS NULL AND style_name_snapshot IS NULL)
    OR (gender IS NOT NULL AND style_id IS NOT NULL AND style_name_snapshot IS NOT NULL)
  );
ALTER TABLE sourcing_decisions ADD COLUMN crafts jsonb
  CHECK(crafts IS NULL OR (jsonb_typeof(crafts)='array' AND jsonb_array_length(crafts) BETWEEN 1 AND 20));
ALTER TABLE sourcing_approval_snapshots
  ADD COLUMN gender text CHECK(gender IN ('男装','女装')),
  ADD COLUMN style_name_snapshot text CHECK(length(btrim(style_name_snapshot)) BETWEEN 1 AND 100);

CREATE FUNCTION guard_sourcing_contract_classification() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.gender IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM sourcing_style_catalog style JOIN operation_events event ON event.event_id=NEW.operation_event_id
    WHERE style.style_id=NEW.style_id AND style.style_name=NEW.style_name_snapshot
      AND event.actor_id=NEW.created_by AND event.request_id=NEW.request_id
      AND event.entity_id=NEW.sourcing_case_id::text AND event.action='sourcing.case.create'
      AND event.after_state->>'gender'=NEW.gender
      AND event.after_state->>'styleId'=NEW.style_id::text
      AND event.after_state->>'styleName'=NEW.style_name_snapshot
  ) THEN RAISE EXCEPTION 'classification requires matching order creation audit' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER sourcing_cases_guard_classification BEFORE INSERT ON sourcing_cases
  FOR EACH ROW EXECUTE FUNCTION guard_sourcing_contract_classification();

CREATE FUNCTION guard_sourcing_decision_crafts() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected jsonb;
BEGIN
  IF NEW.source_type='factory_change' THEN
    SELECT crafts INTO expected FROM sourcing_decisions WHERE sourcing_decision_id=NEW.supersedes_decision_id;
    IF NEW.crafts IS DISTINCT FROM expected THEN
      RAISE EXCEPTION 'factory change must retain confirmed crafts' USING ERRCODE='55000';
    END IF;
  ELSIF NEW.crafts IS NOT NULL THEN
    SELECT jsonb_agg(jsonb_build_object(
      'position',requested.position,'craftId',catalog.craft_id,'craftCode',catalog.craft_code,
      'craftVersion',catalog.version,'craftName',catalog.craft_name
    ) ORDER BY requested.position) INTO expected
    FROM jsonb_array_elements(NEW.crafts) WITH ORDINALITY requested(craft,position)
    JOIN current_craft_catalog catalog ON catalog.craft_id=(requested.craft->>'craftId')::uuid AND catalog.active;
    IF expected IS DISTINCT FROM NEW.crafts
      OR (SELECT count(DISTINCT craft->>'craftId') FROM jsonb_array_elements(NEW.crafts) craft)<>jsonb_array_length(NEW.crafts)
      OR NOT EXISTS(SELECT 1 FROM operation_events event WHERE event.event_id=NEW.operation_event_id
        AND event.actor_id=NEW.decided_by AND event.request_id=NEW.request_id
        AND event.action='sourcing.management_decision.record'
        AND event.authorization_capability='sourcing:decision:record'
        AND event.after_state->'crafts'=NEW.crafts)
    THEN RAISE EXCEPTION 'decision crafts require matching catalog and audit' USING ERRCODE='55000'; END IF;
  ELSIF EXISTS(SELECT 1 FROM sourcing_cases WHERE sourcing_case_id=NEW.sourcing_case_id AND gender IS NOT NULL) THEN
    RAISE EXCEPTION 'new order decisions require confirmed crafts' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER sourcing_decisions_guard_crafts BEFORE INSERT ON sourcing_decisions
  FOR EACH ROW EXECUTE FUNCTION guard_sourcing_decision_crafts();

CREATE OR REPLACE FUNCTION guard_craft_catalog_version_creation()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  audit_event operation_events%ROWTYPE;
  stable_craft_code text;
  previous_version integer;
  previous_craft_name text;
  previous_active boolean;
  previous_state jsonb;
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

  SELECT version,craft_name,active
  INTO previous_version,previous_craft_name,previous_active
  FROM craft_catalog_versions
  WHERE craft_id=NEW.craft_id
  ORDER BY version DESC
  LIMIT 1;

  IF previous_version IS NULL THEN
    IF NEW.version<>1 OR audit_event.action<>'master_data.craft.create'
       OR audit_event.before_state IS NOT NULL
       OR audit_event.authorization_capability NOT IN ('master_data:manage','sourcing:decision:record')
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


ALTER TABLE sourcing_contract_template_versions ADD COLUMN party_a_address text;
INSERT INTO sourcing_contract_template_versions(
  template_version,template_name,party_a_name,party_a_address,signing_place,terms,effective_from
) VALUES(2,'外发服装加工合同 V2（原件核验）','广州市达兴服装制造有限公司',
  '广州市白云区江高镇大田高田大街40号401房','广州市',
  '{"qualityRequirements": "1. 乙方开货前必须做一件产前板经甲方确认才可以开货。\n2. 乙方按甲方确认的产前批办之款式、材料、尺寸、尺码分配进行生产。\n3. 交货前甲方派QC到乙方进行抽查，检验合格后方可出货。\n4. 因此款客户要查货，乙方必须保证质量。若因质量问题造成扣款的，费用有乙方承担。", "delayPenalty": "如上表，若延期一天按加工费的0.5%扣款，若延期两天按加工费的1%扣款，若延期三天按加工费的2%扣款，以此类推，若延期五天以上（含五天），所有损失由乙方负责。", "logistics": "甲乙双方各负责一程运费；（备注：甲方负责送货到物流公司并且安排发货，发物流费用由乙方支付，乙方负责把做好的成品发物流回来，回货物流费用由甲方支付）。", "reasonableLoss": "允许按定单数量+-1%。不可遗失甲方的样板，若遗失按500元/件赔偿。", "defectRate": "甲方接受1%损耗，若乙方超过损耗问题，扣回成本价。并且次品不算加工费，次品还要退回甲方。", "payment": "本月出货，下个月5号前对帐，30号前结款。", "effectiveness": "本合同一式两份，甲乙双方各执一份，自甲乙双方签字盖章后即生效。未尽事宜双方另行补充协议，补充协议为本合同有效组成部份，与本合同具有同等法律效力。", "validity": "本合同有效期为一年。"}'::jsonb,CURRENT_TIMESTAMP);
