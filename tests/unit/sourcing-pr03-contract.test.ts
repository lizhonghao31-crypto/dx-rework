import { readFile } from "node:fs/promises";

import {
  CreateSourcingCaseSchema,
  CreateSourcingIeQuoteSchema,
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
  });

  it("keeps IE price at four decimals and calculates the two-decimal total exactly", () => {
    expect(CreateSourcingIeQuoteSchema.parse({ unitPrice: "12.3456" }))
      .toEqual({ unitPrice: "12.3456" });
    expect(normalizeSourcingUnitPrice("12.3")).toBe("12.3000");
    expect(calculateSourcingTotal("12.3456", 120)).toBe("1481.47");
    expect(calculateSourcingTotal("0.0050", 1)).toBe("0.01");
    expect(() => CreateSourcingIeQuoteSchema.parse({ unitPrice: "12.34567" })).toThrow();
    expect(() => calculateSourcingTotal("0.0001", 1)).toThrow(/总额/);
  });

  it("keeps PR03 UI limited to inquiry creation and IE quote", async () => {
    const page = await readFile("apps/web/src/sourcing-shell-page.tsx", "utf8");
    expect(page).toContain("创建并交给 IE");
    expect(page).toContain("确认 IE 价格");
    expect(page).toContain("系统计算总额");
    expect(page).not.toContain("选择供应商");
    expect(page).not.toContain("老板批准");
    expect(page).not.toContain("登记合同");
  });
});
