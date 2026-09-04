import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  CreateSupplierSchema,
  ReviseSupplierSchema,
} from "@dx-rework/contracts";

describe("SSP-01 supplier profile contract", () => {
  it("normalizes the approved compact profile and rejects unsafe values", () => {
    expect(CreateSupplierSchema.parse({
      supplierCode: "FACTORY_01",
      supplierType: "factory",
      supplierName: " 加工厂一 ",
      contactPerson: " 陈经理 ",
      supportedCrafts: ["车缝", "整烫"],
      dailyCapacity: 1200,
      changeReason: " 首次建档 ",
    })).toEqual(expect.objectContaining({
      supplierName: "加工厂一",
      active: true,
      notes: "",
      contactPerson: "陈经理",
      supportedCrafts: ["车缝", "整烫"],
      dailyCapacity: 1200,
      changeReason: "首次建档",
    }));

    expect(CreateSupplierSchema.safeParse({
      supplierCode: "FACTORY_01",
      supplierType: "factory",
      supplierName: "加工厂一",
      supportedCrafts: ["车缝", "车缝"],
      changeReason: "重复工艺",
    }).success).toBe(false);
    expect(CreateSupplierSchema.safeParse({
      supplierCode: "FACTORY_01",
      supplierType: "factory",
      supplierName: "加工厂一",
      dailyCapacity: 0,
      changeReason: "非法产能",
    }).success).toBe(false);
  });

  it("requires optimistic concurrency for every profile revision", () => {
    const base = {
      supplierName: "加工厂一",
      active: true,
      changeReason: "资料修订",
    };
    expect(ReviseSupplierSchema.safeParse(base).success).toBe(false);
    const revision = ReviseSupplierSchema.parse({ ...base, expectedVersion: 3 });
    expect(revision).toEqual(expect.objectContaining({ expectedVersion: 3 }));
    expect(revision).not.toHaveProperty("notes");
    expect(revision).not.toHaveProperty("supportedCrafts");
  });

  it("adds no import or synchronization path from another business system", async () => {
    const sql = await readFile(
      new URL("../../apps/api/migrations/0143_sourcing_supplier_profile_foundation.sql", import.meta.url),
      "utf8",
    );
    expect(sql).not.toMatch(/\b(import|sync|foreign data wrapper|dblink)\b/i);
    expect(sql).toContain("ALTER TABLE supplier_catalog_versions");
    expect(sql).toContain("supplier_profile:write");
    expect(sql).toContain("supplier_contract_data:read");
  });
});
