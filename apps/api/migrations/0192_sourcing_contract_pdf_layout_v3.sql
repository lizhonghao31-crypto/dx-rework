-- Contract PDF layout V3. Content, commercial terms and business fields are unchanged.
-- New approvals use V3 so already-prepared V2 documents keep their original renderer.

INSERT INTO sourcing_contract_template_versions(
  template_version,template_name,party_a_name,party_a_address,signing_place,terms,effective_from
)
SELECT 3,'外发服装加工合同 V3（版式优化）',party_a_name,party_a_address,signing_place,terms,CURRENT_TIMESTAMP
FROM sourcing_contract_template_versions
WHERE template_version=2;
