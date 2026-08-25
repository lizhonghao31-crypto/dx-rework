import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { ResponsibilityDeterminationResponseSchema } from "../../packages/contracts/src/index.js";

const read = (path: string) => readFile(path, "utf8");

describe("1.0 prelaunch PR-07 responsibility usability", () => {
  it("returns the locked order processing factory in the N07 response", async () => {
    const [contract, service] = await Promise.all([
      read("packages/contracts/src/index.ts"),
      read("apps/api/src/rework/responsibility-determination-service.ts"),
    ]);

    expect(contract).toContain("processingFactory: ReworkProcessingFactorySchema.nullable().optional()");
    expect(service).toContain("processing_factory_supplier_id,processing_factory_supplier_version");
    expect(service).toContain('processingFactory: order.processing_factory_type === "own_factory"');
    expect(service).toContain('order.processing_factory_type === "supplier"');
    const parsed = ResponsibilityDeterminationResponseSchema.parse({
      reworkOrderId: "00000000-0000-4000-8000-000000000001",
      reworkStatus: "pending_responsibility_determination",
      orderVersion: 1,
      processingFactory: {
        type: "supplier",
        supplierId: "00000000-0000-4000-8000-000000000002",
      },
      handlerUserId: null,
      canDetermine: true,
      canTakeover: false,
      canConfirmHighMultiplier: false,
      sourceProcesses: [],
      determination: null,
    });
    expect(parsed.processingFactory).toEqual({
      type: "supplier",
      supplierId: "00000000-0000-4000-8000-000000000002",
    });
  });

  it("prefills processing-factory responsibility while preserving manual override", async () => {
    const panel = await read("apps/web/src/responsibility-determination-panel.tsx");

    expect(panel).toContain("preferredProcessingFactoryId");
    expect(panel).toContain('nextType === "processing_factory"');
    expect(panel).not.toContain("已带入订单加工厂，可重新选择");
    expect(panel).not.toContain("supplierOptionsLoaded");
    expect(panel).toContain("onChange={(supplierId: string) => setAllocation");
  });

  it("uses one neutral process layer and compact responsibility rows", async () => {
    const styles = await read("apps/web/src/responsibility-determination.css");

    expect(styles).toContain(".responsibility-process {");
    expect(styles).toContain("background: var(--dx-v2-color-surface);");
    expect(styles).toContain("padding: 10px;");
    expect(styles).toContain("min-height: 38px;");
    expect(styles).toContain("border-top: 1px solid var(--dx-v2-color-border);");
  });
});
