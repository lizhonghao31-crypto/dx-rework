import { describe, expect, it } from "vitest";

import {
  canReadDaxingPrice,
  canReadSupplierContactData,
  canReadSupplierContractData,
  canReadSupplierPaymentData,
  redactPermissionSensitivePayload,
} from "../../apps/api/src/access/permission-sensitive-field-policy.js";

describe("PR03-B sensitive field policy", () => {
  it("uses the approved Daxing price whitelist", () => {
    for (const role of ["owner_group", "order_merchandiser", "ie_reviewer", "production_management"]) {
      expect(canReadDaxingPrice([role], false)).toBe(true);
    }
    for (const role of ["factory_payables", "embroidery_washing_payables", "fabric_payables", "finance_director", "worker", "warehouse_receiver"]) {
      expect(canReadDaxingPrice([role], false)).toBe(false);
    }
    expect(canReadDaxingPrice([], true)).toBe(true);
  });

  it("keeps supplier finance data on the already-confirmed finance roles", () => {
    expect(canReadSupplierContactData(["order_merchandiser"], false)).toBe(true);
    expect(canReadSupplierContactData(["finance_director"], false)).toBe(false);
    expect(canReadSupplierContactData(["factory_payables"], false)).toBe(false);

    for (const role of ["factory_payables", "finance_director"]) {
      expect(canReadSupplierContractData([role], false)).toBe(true);
      expect(canReadSupplierPaymentData([role], false)).toBe(true);
    }
    for (const role of ["embroidery_washing_payables", "fabric_payables", "ie_reviewer", "worker"]) {
      expect(canReadSupplierContractData([role], false)).toBe(false);
      expect(canReadSupplierPaymentData([role], false)).toBe(false);
    }
  });

  it("redacts supplier fields and derived missing-state without leaking hidden groups", () => {
    const payload = {
      supplierId: "supplier-1",
      supplierName: "测试供应商",
      contactPerson: "张三",
      contactPhone: "13800000000",
      address: "广州",
      contractEntityName: "测试公司",
      partyBRepresentative: "李四",
      payeeName: "测试公司",
      bankAccount: "6222",
      bankName: "测试银行",
      contractDataMissing: ["address", "contractEntityName", "bankName"],
    };

    const finance = redactPermissionSensitivePayload(
      "/master-data/suppliers/supplier-1",
      payload,
      ["finance_director"],
      false,
    ) as Record<string, unknown>;
    expect(finance).not.toHaveProperty("contactPerson");
    expect(finance).not.toHaveProperty("contactPhone");
    expect(finance).not.toHaveProperty("address");
    expect(finance.contractEntityName).toBe("测试公司");
    expect(finance.bankAccount).toBe("6222");
    expect(finance.contractDataMissing).toEqual(["contractEntityName", "bankName"]);

    const worker = redactPermissionSensitivePayload(
      "/master-data/suppliers/supplier-1",
      payload,
      ["worker"],
      false,
    ) as Record<string, unknown>;
    expect(worker).not.toHaveProperty("contactPerson");
    expect(worker).not.toHaveProperty("contractEntityName");
    expect(worker).not.toHaveProperty("bankAccount");
    expect(worker.contractDataMissing).toEqual([]);
  });

  it("redacts derived supplier state on supplier-bearing sourcing routes", () => {
    const factoryPayload = {
      items: [{
        supplierId: "supplier-1",
        supplierName: "测试供应商",
        contractDataMissing: ["address", "contractEntityName", "partyBRepresentative", "payeeName", "bankAccount", "bankName"],
      }],
    };
    expect(redactPermissionSensitivePayload(
      "/sourcing/factories",
      factoryPayload,
      ["finance_director"],
      false,
    )).toEqual({
      items: [{
        supplierId: "supplier-1",
        supplierName: "测试供应商",
        contractDataMissing: ["contractEntityName", "partyBRepresentative", "payeeName", "bankAccount", "bankName"],
      }],
    });
    expect(redactPermissionSensitivePayload(
      "/sourcing/factories",
      factoryPayload,
      ["ie_reviewer"],
      false,
    )).toEqual({
      items: [{ supplierId: "supplier-1", supplierName: "测试供应商", contractDataMissing: [] }],
    });

    const contractPayload = {
      item: {
        status: "pending_supplement",
        missingFields: ["address", "contractEntityName", "partyBRepresentative", "payeeName", "bankAccount", "bankName"],
      },
    };
    expect(redactPermissionSensitivePayload(
      "/sourcing/cases/case-1/contract",
      contractPayload,
      ["finance_director"],
      false,
    )).toEqual({
      item: {
        status: "pending_supplement",
        missingFields: ["contractEntityName", "partyBRepresentative", "payeeName", "bankAccount", "bankName"],
      },
    });
    expect(redactPermissionSensitivePayload(
      "/sourcing/cases/case-1/contract/generate",
      contractPayload,
      ["ie_reviewer"],
      false,
    )).toEqual({ item: { status: "pending_supplement", missingFields: [] } });
    expect(redactPermissionSensitivePayload(
      "/sourcing/cases/case-1/contract",
      contractPayload,
      [],
      true,
    )).toEqual(contractPayload);
  });

  it("redacts Daxing price recursively from sourcing responses", () => {
    const payload = {
      items: [{
        sourcingCaseId: "case-1",
        daxingUnitPrice: "10.00",
        approvalSnapshot: { approvalDaxingUnitPrice: "10.00", totalAmount: "100.00" },
      }],
    };
    expect(redactPermissionSensitivePayload("/sourcing/cases", payload, ["finance_director"], false))
      .toEqual({ items: [{ sourcingCaseId: "case-1", approvalSnapshot: { totalAmount: "100.00" } }] });
    expect(redactPermissionSensitivePayload("/sourcing/cases", payload, ["ie_reviewer"], false)).toEqual(payload);
  });
});
