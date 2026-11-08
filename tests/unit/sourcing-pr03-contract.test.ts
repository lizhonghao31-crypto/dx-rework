import { readFile } from "node:fs/promises";

import {
  calculateSourcingOrderQuantity,
  calculateSourcingTotalExact,
  CreateSourcingCaseSchema,
  CreateSourcingIeQuoteSchema,
  DecideSourcingOwnerSchema,
  DecideSourcingExceptionSchema,
  RecordSourcingFinanceReconciliationSchema,
  RecordSourcingManagementDecisionSchema,
} from "@dx-rework/contracts";
import { describe, expect, it } from "vitest";

import {
  calculateSourcingTotal,
  canViewSourcingDaxingPrice,
  normalizeSourcingUnitPrice,
} from "../../apps/api/src/sourcing/sourcing-service.js";

describe("sourcing PR03 contracts", () => {
  it("accepts 1, 2, and 5 style/color rows and derives total quantity", () => {
    const line = (index: number) => ({
      styleNo: `DX-${index}`,
      ...(index === 2 ? { alternateStyleNo: "DX-ALT-2" } : {}),
      color: index % 2 ? "黑色" : "白色",
      quantity: index * 10,
      externalUnitPrice: index % 2 ? "12.34" : "13.5000",
    });
    const parse = (count: number) => CreateSourcingCaseSchema.parse({
      gender: "男装", styleName: "梭织短裤",
      estimatedCutPieceSendDate: "2026-09-10",
      deliveryDate: "2026-09-15",
      lineItems: Array.from({ length: count }, (_value, index) => line(index + 1)),
      daxingUnitPrice: "10.2500",
      attachmentIds: ["00000000-0000-4000-8000-000000000301"],
    });

    expect(parse(1).lineItems).toHaveLength(1);
    expect(parse(2).lineItems.map((item) => item.externalUnitPrice))
      .toEqual(["12.34", "13.5000"]);
    expect(parse(5).lineItems).toHaveLength(5);
    expect(calculateSourcingOrderQuantity(parse(5).lineItems)).toBe(150);
  });

  it("rejects illegal row quantities, excessive precision, and caller totals", () => {
    const valid = {
      gender: "男装", styleName: "梭织短裤",
      estimatedCutPieceSendDate: "2026-09-10",
      deliveryDate: "2026-09-15",
      lineItems: [{
        styleNo: "DX-100",
        color: "黑色",
        quantity: 120,
        externalUnitPrice: "12.34",
      }],
      daxingUnitPrice: "10.0000",
      attachmentIds: ["00000000-0000-4000-8000-000000000301"],
    };
    expect(() => CreateSourcingCaseSchema.parse({
      ...valid,
      lineItems: [{ ...valid.lineItems[0], quantity: 1.5 }],
    })).toThrow();
    expect(() => CreateSourcingCaseSchema.parse({
      ...valid,
      lineItems: [{ ...valid.lineItems[0], externalUnitPrice: "12.34567" }],
    })).toThrow();
    expect(() => CreateSourcingCaseSchema.parse({
      ...valid,
      orderQuantity: 120,
    })).toThrow();
    expect(() => CreateSourcingCaseSchema.parse({
      ...valid,
      styleNo: "CALLER-CONTROLLED",
    })).toThrow();
    expect(() => CreateSourcingCaseSchema.parse({
      ...valid,
      estimatedCutPieceSendDate: "2026-02-31",
    })).toThrow(/日历日期/);
    expect(() => CreateSourcingCaseSchema.parse({
      ...valid,
      estimatedCutPieceSendDate: "2026-99-99",
    })).toThrow();
  });

  it("validates new IE prices at two effective decimals while preserving historic calculations", () => {
    expect(CreateSourcingIeQuoteSchema.parse({ unitPrice: "12.34" }))
      .toEqual({ linePrices: [{ position: 1, unitPrice: "12.34" }], quoteReason: undefined });
    expect(normalizeSourcingUnitPrice("12.3")).toBe("12.3000");
    expect(calculateSourcingTotal("12.3456", 120)).toBe("1481.47");
    expect(calculateSourcingTotalExact("176.1933", 54_550)).toBe("9611344.52");
    expect(calculateSourcingTotal("0.0050", 1)).toBe("0.01");
    expect(() => CreateSourcingIeQuoteSchema.parse({ unitPrice: "12.34567" })).toThrow();
    expect(() => calculateSourcingTotal("0.0001", 1)).toThrow(/总额/);
  });

  it("validates management adjustments and accepts direct owner decisions", () => {
    expect(RecordSourcingManagementDecisionSchema.parse({
      craftIds: ["00000000-0000-4000-8000-000000000401"],
      supplierId: "00000000-0000-4000-8000-000000000200",
      unitPrice: "12.5000",
      decisionReason: "结合产能调整",
    })).toMatchObject({ linePrices: [{ position: 1, unitPrice: "12.5000" }] });
    expect(DecideSourcingOwnerSchema.parse({ decision: "approved" }))
      .toEqual({ decision: "approved" });
    expect(DecideSourcingOwnerSchema.parse({ decision: "rejected" }))
      .toEqual({ decision: "rejected" });
    expect(() => DecideSourcingOwnerSchema.parse({ decision: "rejected", decisionReason: "x".repeat(501) })).toThrow();
  });

  it("keeps finance declarative and requires explicit exception closure", () => {
    expect(RecordSourcingFinanceReconciliationSchema.parse({
      result: "match",
    })).toEqual({ result: "match" });
    expect(RecordSourcingFinanceReconciliationSchema.parse({
      result: "difference",
      differenceFields: ["total_amount"],
      differenceReason: "发票总额与批准决定不一致",
    })).toMatchObject({ result: "difference", differenceFields: ["total_amount"] });
    expect(() => DecideSourcingExceptionSchema.parse({ resolution: "close" })).toThrow();
  });

  it("limits Daxing price to the explicit internal role set", () => {
    for (const role of [
      "root_superuser",
      "order_merchandiser",
      "ie_reviewer",
      "production_management",
      "owner_group",
      "factory_payables",
    ]) {
      expect(canViewSourcingDaxingPrice({
        actorId: "00000000-0000-4000-8000-000000000001",
        actorRoles: [role],
      }, "00000000-0000-4000-8000-000000000001")).toBe(true);
    }
    expect(canViewSourcingDaxingPrice({
      actorId: "00000000-0000-4000-8000-000000000002",
      actorRoles: ["order_merchandiser"],
    }, "00000000-0000-4000-8000-000000000001")).toBe(false);
    for (const role of ["worker", "warehouse_keeper", "external_production_reporter", "unrelated_role"]) {
      expect(canViewSourcingDaxingPrice({
        actorId: "00000000-0000-4000-8000-000000000002",
        actorRoles: [role],
      }, "00000000-0000-4000-8000-000000000001")).toBe(false);
    }
  });

  it("persists immutable line facts and keeps internal price out of unrelated DTOs", async () => {
    const [migration, service, page, contracts] = await Promise.all([
      readFile("apps/api/migrations/0144_sourcing_multi_style_pricing.sql", "utf8"),
      readFile("apps/api/src/sourcing/sourcing-service.ts", "utf8"),
      readFile("apps/web/src/sourcing-workspace-page.tsx", "utf8"),
      readFile("packages/contracts/src/sourcing.ts", "utf8"),
    ]);
    expect(migration).toContain("CREATE TABLE sourcing_case_lines");
    expect(migration).toContain("sourcing_case_lines_no_update");
    expect(migration).toContain("sourcing_case_lines_no_delete");
    expect(migration).toContain("daxingUnitPriceRecorded");
    expect(migration).not.toContain("after_state ->> 'daxingUnitPrice'");
    expect(service).toContain('export {canViewSourcingDaxingPrice} from "./sourcing-case-mapping.js"');
    expect(await readFile("apps/api/src/sourcing/sourcing-case-mapping.ts","utf8")).toContain("canViewSourcingDaxingPrice(actor,row.effective_created_by===undefined?row.created_by:row.effective_created_by)");
    expect(contracts).toContain("daxingUnitPrice: z.string().optional()");
    expect(contracts).not.toMatch(/RecordSourcingContractSchema[\s\S]{0,400}daxingUnitPrice/);
    expect(page).not.toContain("加工报价由 IE 首次填写");
    expect(page).toContain("预计裁片发出日期");
    expect(page).not.toContain("current[0]?.externalUnitPrice");
    expect(page).toContain("删除第");
  });

  it("keeps the five-stage sourcing flow visible through finance closure", async () => {
    const page = await readFile("apps/web/src/sourcing-workspace-page.tsx", "utf8");
    expect(page).toContain("提交并进入审批");
    expect(page).toContain("提交 IE 逐款价格");
    expect(page).toContain("请选择加工厂");
    expect(page).toContain("提交调价与选厂");
    expect(page).not.toContain("审批说明 / 驳回原因");
    expect(page).not.toContain("ownerReason");
    expect(page).toContain("sourcing-owner-reject");
    expect(page).toContain('{ decision: "rejected" }');
    expect(page).not.toContain(">登记合同</button>");
    expect(page).not.toContain("发起中途换厂");
    expect(page).not.toContain("生产管理核实换厂");
    expect(page).toContain("确认与合同一致");
    expect(page).toContain("财务不能在此页改写业务数据");
    expect(page).not.toContain(">提交财务核对</button>");
    expect(page).toContain("确认差异并闭环");
    expect(page).toContain("退回财务重核");
  });
});
