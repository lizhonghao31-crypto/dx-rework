import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const read = (path: string) => readFile(path, "utf8");

describe("PR-01 stable receiving batch propagation", () => {
  it("carries receivingBatchId from the board through N01 without making local save a server binding", async () => {
    const [board, form] = await Promise.all([
      read("apps/web/src/order-board-page.tsx"),
      read("apps/web/src/rework-v2-form.tsx"),
    ]);

    expect(board).toContain("receivingBatchId: row.receivingBatchId");
    expect(form).toContain('get("receivingBatchId")');
    expect(form).toContain("parsed.receivingBatchId !== requestedBatchId");
    expect(form).toContain("receivingBatchId: receivingBatchId ?? null");
    expect(form).toContain("writeLocalN01Draft(form, images, receivingBatchId)");
    expect(form).toContain("...(receivingBatchId ? { receivingBatchId } : {})");
    expect(form).toContain('"rework-orders/drafts"');
  });

  it("accepts the batch id only on the create route and writes the explicit relation in the service", async () => {
    const [routes, service] = await Promise.all([
      read("apps/api/src/rework/routes.ts"),
      read("apps/api/src/rework/service.ts"),
    ]);

    expect(routes).toContain("CreateReworkDraftWithReceivingBatchSchema");
    expect(routes).toContain("const { receivingBatchId, ...draft }");
    expect(routes).toContain("UUID_PATTERN.test(receivingBatchId)");
    expect(routes).toContain("parse(CreateReworkDraftWithReceivingBatchSchema, request.body)");
    expect(routes).toContain("parse(UpdateReworkDraftSchema, request.body)");
    expect(service).toContain("input.receivingBatchId");
    expect(service).toContain("pg_advisory_xact_lock(hashtext($1))");
    expect(service).toContain("source_receiving_batch_id,created_by,updated_by");
    expect(service).toContain("收货批次与款号不一致");
    expect(service).toContain("已完成返工的收货批次不能再次发起返工");
  });
});
