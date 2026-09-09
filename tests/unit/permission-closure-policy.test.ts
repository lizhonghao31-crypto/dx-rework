import { describe, expect, it } from "vitest";

import {
  canReadDaxingPrice,
  canReadSupplierContactData,
  canReadSupplierContractData,
  isRootOnlyPersonnelPath,
  redactPermissionSensitivePayload,
} from "../../apps/api/src/access/permission-closure-policy.js";

describe("PR03 permission closure policy", () => {
  it("keeps personnel and permission administration Root-only while preserving bootstrap", () => {
    expect(isRootOnlyPersonnelPath("/access/roles")).toBe(true);
    expect(isRootOnlyPersonnelPath("/access/role-assignments/assignment-1")).toBe(true);
    expect(isRootOnlyPersonnelPath("/employee-access/employees")).toBe(true);
    expect(isRootOnlyPersonnelPath("/employee-access/bootstrap")).toBe(false);
    expect(isRootOnlyPersonnelPath("/master-data/suppliers")).toBe(false);
  });

  it("uses the confirmed supplier contact and contract whitelists", () => {
    expect(canReadSupplierContactData(["order_merchandiser"], false)).toBe(true);
    expect(canReadSupplierContactData(["ie_reviewer"], false)).toBe(false);
    expect(canReadSupplierContactData(["finance_director"], false)).toBe(false);
    expect(canReadSupplierContractData(["factory_payables"], false)).toBe(true);
    expect(canReadSupplierContractData(["finance_director"], false)).toBe(true);
    expect(canReadSupplierContractData(["ie_reviewer"], false)).toBe(false);
  });

  it("redacts supplier contact data without removing finance contract data", () => {
    const supplier = {
      supplierId: "supplier-1",
      name: "测试供应商",
      contactPerson: "张三",
      contactPhone: "13800000000",
      address: "广州",
      contractEntityName: "测试公司",
      partyBRepresentative: "李四",
      payeeName: "测试公司",
      bankAccount: "6222",
      bankName: "测试银行",
      contractDataMissing: ["address", "bankName"],
    };
    const finance = redactPermissionSensitivePayload(
      "/master-data/suppliers/supplier-1",
      supplier,
      ["finance_director"],
      false,
    ) as Record<string, unknown>;
    expect(finance).not.toHaveProperty("contactPerson");
    expect(finance).not.toHaveProperty("contactPhone");
    expect(finance).not.toHaveProperty("address");
    expect(finance.contractEntityName).toBe("测试公司");
    expect(finance.bankAccount).toBe("6222");
    expect(finance.contractDataMissing).toEqual(["bankName"]);
  });

  it("allows Daxing price only to the confirmed business roles", () => {
    expect(canReadDaxingPrice(["owner_group"], false)).toBe(true);
    expect(canReadDaxingPrice(["order_merchandiser"], false)).toBe(true);
    expect(canReadDaxingPrice(["ie_reviewer"], false)).toBe(true);
    expect(canReadDaxingPrice(["production_management"], false)).toBe(true);
    expect(canReadDaxingPrice(["factory_payables"], false)).toBe(false);
    expect(canReadDaxingPrice(["finance_director"], false)).toBe(false);

    const payload = {
      sourcingCaseId: "case-1",
      daxingUnitPrice: "10.0000",
      approvalDaxingUnitPrice: "10.0000",
      totalAmount: "100.00",
    };
    expect(redactPermissionSensitivePayload("/sourcing/case-1", payload, ["factory_payables"], false))
      .toEqual({ sourcingCaseId: "case-1", totalAmount: "100.00" });
    expect(redactPermissionSensitivePayload("/sourcing/case-1", payload, ["ie_reviewer"], false))
      .toEqual(payload);
  });
});
