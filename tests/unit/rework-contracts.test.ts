import { readFile } from "node:fs/promises";

import {
  CreateReworkDraftSchema,
  UpdateReworkDraftSchema,
} from "@dx-rework/contracts";
import { transitionReworkOrder } from "@dx-rework/domain";
import { describe, expect, it } from "vitest";

describe("rework initiation contracts", () => {
  it("allows incomplete drafts while keeping one strict style field", () => {
    expect(CreateReworkDraftSchema.safeParse({}).success).toBe(true);
    expect(CreateReworkDraftSchema.safeParse({ styleNo: "PD20529725" }).success).toBe(true);
    expect(CreateReworkDraftSchema.safeParse({
      styleNo: "PD20529725",
      styleNos: ["PD20529725", "PD20529726"],
    }).success).toBe(false);
  });

  it("rejects invalid quantities, duplicate attachments and ambiguous factories", () => {
    const attachmentId = "00000000-0000-4000-8000-000000000001";
    expect(UpdateReworkDraftSchema.safeParse({
      expectedVersion: 1,
      reworkQuantity: 1.5,
    }).success).toBe(false);
    expect(UpdateReworkDraftSchema.safeParse({
      expectedVersion: 1,
      attachmentIds: [attachmentId, attachmentId],
    }).success).toBe(false);
    expect(UpdateReworkDraftSchema.safeParse({
      expectedVersion: 1,
      processingFactory: {
        type: "own_factory",
        supplierId: "00000000-0000-4000-8000-000000000002",
      },
    }).success).toBe(false);
  });

  it("permits only the PR-05 state transitions", () => {
    expect(transitionReworkOrder("draft", "pending_process_configuration"))
      .toBe("pending_process_configuration");
    expect(transitionReworkOrder("pending_process_configuration", "draft"))
      .toBe("draft");
    expect(transitionReworkOrder("draft", "cancelled")).toBe("cancelled");
    expect(() => transitionReworkOrder("cancelled", "draft"))
      .toThrowError(/Cannot transition/);
  });

  it("keeps migration-level audit, attachment and identity guards", async () => {
    const migration = await readFile(
      new URL("../../apps/api/migrations/0006_rework_initiation.sql", import.meta.url),
      "utf8",
    );
    expect(migration).toContain("next_rework_order_number");
    expect(migration).toContain("rework_orders_external_source_idx");
    expect(migration).toContain("attachments_rework_binding_guard");
    expect(migration).toContain("attachments_rework_no_delete");
    expect(migration).toContain("bound rework evidence is immutable");
    expect(migration).toContain("rework order write requires trusted audit context");
    expect(migration).toContain("allocated rework number is immutable");
    expect(migration).not.toMatch(/ALTER TABLE\s+.*000[1-5]/i);
  });
});
