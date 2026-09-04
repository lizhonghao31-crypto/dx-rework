import { describe, expect, it } from "vitest";

import type { AuthorizedUser } from "../../apps/web/src/auth.js";
import {
  canAccessSupplierCenter,
  canWriteSupplierProfiles,
  filterSupplierDirectory,
  nextSupplierSelection,
  supplierContractMissingLabels,
  type SupplierSummary,
} from "../../apps/web/src/supplier-center-model.js";

const user = (capabilities: string[], isRoot = false): AuthorizedUser => ({
  id: "user-1",
  displayName: "测试用户",
  capabilities,
  businessRoles: ["order_merchandiser"],
  isRoot,
});

const suppliers: SupplierSummary[] = [
  {
    supplierId: "00000000-0000-4000-8000-000000000001",
    supplierCode: "FAC_001",
    supplierType: "factory",
    version: 2,
    supplierName: "广州市海珠区达兴服装供应链长期合作加工厂第一生产基地",
    active: true,
    supportedCrafts: ["车缝", "整烫"],
    dailyCapacity: 12800,
    contractDataMissing: [],
  },
  {
    supplierId: "00000000-0000-4000-8000-000000000002",
    supplierCode: "FAB_002",
    supplierType: "fabric",
    version: 4,
    supplierName: "联发布行",
    active: false,
    supportedCrafts: [],
    dailyCapacity: null,
    contractDataMissing: ["bankAccount"],
  },
];

describe("SSP-02 supplier center model", () => {
  it("shows the center to profile readers while keeping maintenance Root-only", () => {
    expect(canAccessSupplierCenter(user(["supplier_profile:read"]))).toBe(true);
    expect(canWriteSupplierProfiles(user(["supplier_profile:read"]))).toBe(false);
    expect(canWriteSupplierProfiles(user([], true))).toBe(true);
    expect(canAccessSupplierCenter(user([]))).toBe(false);
  });

  it("filters long names, crafts, types and inactive suppliers without truncating data", () => {
    expect(filterSupplierDirectory(suppliers, { query: "第一生产基地", type: "all", status: "active" })).toEqual([suppliers[0]]);
    expect(filterSupplierDirectory(suppliers, { query: "车缝", type: "factory", status: "all" })).toEqual([suppliers[0]]);
    expect(filterSupplierDirectory(suppliers, { query: "", type: "all", status: "inactive" })).toEqual([suppliers[1]]);
  });

  it("renders concrete contract field names instead of a percentage score", () => {
    expect(supplierContractMissingLabels(["partyBRepresentative", "bankAccount", "bankName"]))
      .toEqual(["乙方代表", "收款账号", "开户行"]);
  });

  it("starts mobile users in the directory and desktop users in the first detail", () => {
    expect(nextSupplierSelection("", suppliers, true)).toBe("");
    expect(nextSupplierSelection("", suppliers, false)).toBe(suppliers[0]?.supplierId);
    expect(nextSupplierSelection(suppliers[1]!.supplierId, suppliers, true)).toBe(suppliers[1]?.supplierId);
  });
});
