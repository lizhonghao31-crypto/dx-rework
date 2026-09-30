import { loadContractContent } from "../../apps/api/src/sourcing/sourcing-contract-content.js";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { draftFromProfile, type SupplierProfile } from "../../apps/web/src/supplier-profile-draft.js";

const source = (path: string): string => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

const profile = (contractEntityName: string | null): SupplierProfile => ({
  supplierId: "00000000-0000-4000-8000-000000000191",
  supplierCode: "SUP_OPTIONAL_SIGNING_NAME",
  supplierType: "factory",
  version: 1,
  supplierName: "嘉顺制衣",
  active: true,
  supportedCrafts: ["车缝"],
  dailyCapacity: null,
  contractDataMissing: [],
  notes: "",
  contactPerson: "陈经理",
  contactPhone: "13800000000",
  address: "广州一号路",
  contractEntityName,
  partyBRepresentative: null,
  payeeName: "嘉顺制衣",
  bankAccount: "001234567890",
  bankName: "测试银行",
  changeReason: "测试",
  changedBy: "测试用户",
  changedAt: "2026-09-16T00:00:00.000Z",
});

describe("optional supplier contract signing name", () => {
  it("keeps the form blank when the effective signing name is just the supplier-name fallback", () => {
    expect(draftFromProfile(profile("嘉顺制衣")).contractEntityName).toBe("");
    expect(draftFromProfile(profile("广州市嘉顺服装有限公司")).contractEntityName)
      .toBe("广州市嘉顺服装有限公司");
  });

  it("does not count signing name as a new-contract missing field and renders supplier name as fallback", async () => {
    const service = source("apps/api/src/sourcing/sourcing-contract-service.ts");
    expect(service).toContain("'contractEntityName',COALESCE(snapshot.contract_entity_name,snapshot.supplier_name_snapshot)");
    expect(service).not.toContain("CASE WHEN snapshot.contract_entity_name IS NULL THEN 'contractEntityName' END");
    for (const [legalName,supplements,expected] of [
      [null,[],"嘉顺制衣"],["",[],"嘉顺制衣"],["广州市嘉顺服装有限公司",[],"广州市嘉顺服装有限公司"],
      [null,[{field_name:"contractEntityName",field_value:"本单补充签约名称"}],"本单补充签约名称"],
    ] as const) {
      let queryCount=0;
      const database={query:async()=>({rows:queryCount++===0?[{template_version:4,contract_number:"DX-WF-20260930-000001",party_a_name:"甲方",signing_place:"广州",terms:{},
        approval_snapshot:{supplierName:"嘉顺制衣",contractEntityName:legalName,approvedAt:"2026-09-30T00:00:00Z",quantity:20,totalAmount:"200.00",lines:[]}}]:supplements})};
      expect((await loadContractContent(database as never,"document")).partyBName).toBe(expected);
    }
  });

  it("projects supplier name as the current fallback and releases existing pending documents from the old missing marker", () => {
    const migration = source("apps/api/migrations/0191_supplier_contract_signing_name_optional.sql");
    expect(migration).toContain("COALESCE(NULLIF(btrim(version.contract_entity_name),''),version.supplier_name) AS contract_entity_name");
    expect(migration).toContain("array_remove(missing_fields,'contractEntityName')");
    expect(migration).toContain("aaa_supplier_contract_entity_name_optional");
  });

  it("keeps the batch template compatible while explaining that the signing name is optional", () => {
    const template = source("apps/api/src/access/supplier-batch-template.ts");
    expect(template).toContain("仅当合同签约名称与供应商名称不同时填写");
    expect(template).toContain("留空时合同自动使用供应商名称");
  });
});
