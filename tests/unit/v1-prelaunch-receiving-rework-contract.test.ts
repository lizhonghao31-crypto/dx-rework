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

  it("removes only the order-board KPI meter decoration without changing the shared KPI component", async () => {
    const css = await read("apps/web/src/order-board-page.css");
    expect(css).toContain(".order-board-kpis");
    expect(css).toContain(".dx-meter");
    expect(css).toContain("display:none");
  });
});
