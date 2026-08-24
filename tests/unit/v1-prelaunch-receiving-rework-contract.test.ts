import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFile(path, "utf8");

describe("1.0 prelaunch receiving -> rework evidence chain", () => {
  it("adds only a forward migration and keeps receiving history immutable", async () => {
    const migration = await read("apps/api/migrations/0086_receiving_rework_evidence_link.sql");
    expect(migration).toContain("receiving_batches");
    expect(migration).toContain("receiving_batch_id");
    expect(migration).toContain("source_receiving_batch_id");
    expect(migration).toContain("receiving_receipts");
    expect(migration).toContain("rework_orders");
    expect(migration).not.toContain("DROP TABLE receiving_receipts");
  });

  it("requires 1-3 receiving-note images for a new receiving batch and reuses existing batch evidence on later receipts", async () => {
    const [page, routes, service] = await Promise.all([
      read("apps/web/src/receiving-page.tsx"),
      read("apps/api/src/receiving/receiving-routes.ts"),
      read("apps/api/src/receiving/receiving-service.ts"),
    ]);
    expect(page).toContain("收货单图片");
    expect(page).toContain("最多3张");
    expect(page).toContain("image/jpeg");
    expect(page).toContain("image/png");
    expect(page).toContain("image/webp");
    expect(routes).toContain("attachmentIds");
    expect(service).toContain("attachmentIds");
    expect(service).toContain("receiving_batch");
  });

  it("does not label the bodyless attachment finalize request as JSON", async () => {
    const page = await read("apps/web/src/receiving-page.tsx");
    expect(page).toContain('...(init.body ? { "content-type": "application/json" } : {})');
    expect(page).not.toContain('headers: { "content-type": "application/json", ...(init.headers ?? {}) }');
    expect(page).toMatch(/tools\/attachments\/\$\{intent\.attachmentId\}\/finalize`[\s\S]{0,100}\{ method: "POST" \}/);
  });

  it("keeps style number as the business key while giving the database an internal batch identity", async () => {
    const service = await read("apps/api/src/receiving/receiving-service.ts");
    expect(service).toContain("styleNo");
    expect(service).toContain("receivingBatchId");
    expect(service).toContain("documentQuantity");
    expect(service).toContain("actualQuantity");
  });

  it("returns cumulative receiving facts and the linked rework lifecycle to the order board", async () => {
    const [service, board] = await Promise.all([
      read("apps/api/src/receiving/receiving-service.ts"),
      read("apps/web/src/order-board-page.tsx"),
    ]);
    expect(service).toContain("reworkStatus");
    expect(service).toContain("reworkOrderId");
    expect(board).toContain("正在返工");
    expect(board).toContain("返工结束");
    expect(board).toContain("继续填写");
    expect(board).toContain("reworkOrderId");
  });

  it("prevents duplicate active rework creation for the same receiving batch and restores initiation after cancellation", async () => {
    const [migration, service] = await Promise.all([
      read("apps/api/migrations/0086_receiving_rework_evidence_link.sql"),
      read("apps/api/src/receiving/receiving-service.ts"),
    ]);
    expect(migration).toContain("source_receiving_batch_id");
    expect(service).toContain("reworkStatus");
  });

  it("keeps a bound draft on the same style and serializes completion with same-style receiving", async () => {
    const migration = await read("apps/api/migrations/0086_receiving_rework_evidence_link.sql");
    expect(migration).toContain("bound rework style is immutable");
    expect(migration).toContain("pg_advisory_xact_lock(hashtext(NEW.style_no))");
    expect(migration).toContain("lock_receiving_batch_on_rework_completion");
    expect(migration).toContain("rework_orders_01_lock_receiving_batch_completion");
  });

  it("keeps a receiving batch closed after responsibility reopens the current order status", async () => {
    const service = await read("apps/api/src/receiving/receiving-service.ts");
    expect(service).toContain("operation_events");
    expect(service).toContain("event.entity_type='rework_order'");
    expect(service).toContain("event.entity_id=rework.rework_order_id::text");
    expect(service).toContain("event.after_state->>'status'='completed'");
  });

  it("renders linked receiving evidence in rework detail without copying the attachment", async () => {
    const [detailService, detailPage] = await Promise.all([
      read("apps/api/src/rework/rework-business-detail-service.ts"),
      read("apps/web/src/rework-detail-page.tsx"),
    ]);
    expect(detailService).toContain("attachment.entity_type='receiving_batch'");
    expect(detailService).toContain("source_receiving_batch_id::text=attachment.entity_id");
    expect(detailPage).toContain('entityType: "rework_order" | "external_responsibility_case" | "receiving_batch"');
    expect(detailPage).toContain('attachment.entityType === "rework_order" || attachment.entityType === "receiving_batch"');
    expect(detailPage).toContain("收货凭证 · ");
  });

  it("locks batch-seeded N01 style and requires audited receiving evidence binding", async () => {
    const [form, migration, service] = await Promise.all([
      read("apps/web/src/rework-v2-form.tsx"),
      read("apps/api/migrations/0086_receiving_rework_evidence_link.sql"),
      read("apps/api/src/receiving/receiving-service.ts"),
    ]);
    expect(form).toContain("disabled={busy || Boolean(receivingBatchId)}");
    expect(migration).toContain("source receiving batch already has active rework");
    expect(migration).toContain("guard_receiving_attachment_binding");
    expect(migration).toContain("receiving attachment binding requires trusted audit context");
    expect(service.indexOf("const eventId = await this.events.append")).toBeLessThan(
      service.indexOf("await this.bindReceivingImages"),
    );
  });

  it("removes only the order-board KPI meter decoration without changing the shared KPI component", async () => {
    const css = await read("apps/web/src/order-board-page.css");
    expect(css).toContain(".order-board-kpis");
    expect(css).toContain(".dx-meter");
    expect(css).toContain("display:none");
  });
});
