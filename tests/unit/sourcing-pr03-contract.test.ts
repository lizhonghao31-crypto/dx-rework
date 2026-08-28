import { readFile } from "node:fs/promises";

import {
  calculateSourcingTotalExact,
  CreateSourcingCaseSchema,
  CreateSourcingIeQuoteSchema,
  DecideSourcingOwnerSchema,
  RecordSourcingManagementDecisionSchema,
} from "@dx-rework/contracts";
import { describe, expect, it } from "vitest";

import {
  calculateSourcingTotal,
  normalizeSourcingUnitPrice,
} from "../../apps/api/src/sourcing/sourcing-service.js";

describe("sourcing PR03 contracts", () => {
  it("accepts one formal ERP order and rejects invalid quantities", () => {
    expect(CreateSourcingCaseSchema.parse({
      erpOrderNo: "ERP-2026-001",
      styleNo: "DX-100",
      orderQuantity: 120,
    })).toEqual({
      erpOrderNo: "ERP-2026-001",
      styleNo: "DX-100",
      orderQuantity: 120,
    });
    expect(() => CreateSourcingCaseSchema.parse({
      erpOrderNo: "ERP-2026-001",
      styleNo: "DX-100",
      orderQuantity: 1.5,
    })).toThrow();
    expect(() => CreateSourcingCaseSchema.parse({
      erpOrderId: "caller-controlled-id",
      erpOrderNo: "ERP-2026-001",
      styleNo: "DX-100",
      orderQuantity: 120,
    })).toThrow();
  });

  it("keeps IE price at four decimals and calculates the two-decimal total exactly", () => {
    expect(CreateSourcingIeQuoteSchema.parse({ unitPrice: "12.3456" }))
      .toEqual({ unitPrice: "12.3456" });
    expect(normalizeSourcingUnitPrice("12.3")).toBe("12.3000");
    expect(calculateSourcingTotal("12.3456", 120)).toBe("1481.47");
    expect(calculateSourcingTotalExact("176.1933", 54_550)).toBe("9611344.52");
    expect(calculateSourcingTotal("0.0050", 1)).toBe("0.01");
    expect(() => CreateSourcingIeQuoteSchema.parse({ unitPrice: "12.34567" })).toThrow();
    expect(() => calculateSourcingTotal("0.0001", 1)).toThrow(/总额/);
  });

  it("validates management adjustments and requires an owner rejection reason", () => {
    expect(RecordSourcingManagementDecisionSchema.parse({
      supplierId: "00000000-0000-4000-8000-000000000200",
      unitPrice: "12.5000",
      decisionReason: "结合产能调整",
    })).toMatchObject({ unitPrice: "12.5000" });
    expect(DecideSourcingOwnerSchema.parse({ decision: "approved" }))
      .toEqual({ decision: "approved" });
    expect(() => DecideSourcingOwnerSchema.parse({ decision: "rejected" })).toThrow();
  });

  it("keeps PR04 UI inside management selection and owner approval", async () => {
    const page = await readFile("apps/web/src/sourcing-workspace-page.tsx", "utf8");
    expect(page).toContain("提交并进入审批");
    expect(page).toContain("提交 IE 价格");
    expect(page).toContain("请选择加工厂");
    expect(page).toContain("提交调价与选厂");
    expect(page).toContain("审批说明 / 驳回原因");
    expect(page).not.toContain("登记合同执行");
    expect(page).not.toContain("中途换厂");
    expect(page).not.toContain("提交财务核对");
  });
});
