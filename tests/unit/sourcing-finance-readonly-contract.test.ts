import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";

describe("sourcing finance readonly confirmation", () => {
  it("accepts only a declared result and derives core facts on the server", async () => {
    const [contract, service, page] = await Promise.all([
      readFile("packages/contracts/src/sourcing.ts", "utf8"),
      readFile("apps/api/src/sourcing/sourcing-service.ts", "utf8"),
      readFile("apps/web/src/sourcing-workspace-page.tsx", "utf8"),
    ]);
    expect(contract).toContain('result: z.enum(["match", "difference"])');
    expect(contract).not.toContain("supplierId: IdSchema,\n  unitPrice: MoneyInputSchema,\n  quantity:");
    expect(service).toContain("source.expected_unit_price");
    expect(service).toContain("source.expected_total_amount");
    expect(service).toContain('input.result === "difference"');
    expect(page).toContain("财务仅核对老板批准的合同事实");
    expect(page).toContain("确认与合同一致");
    expect(page).toContain("提交差异核实");
    expect(page).not.toContain("发起中途换厂");
    expect(page).not.toContain("实际加工厂");
  });
});
