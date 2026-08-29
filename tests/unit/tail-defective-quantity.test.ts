import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const serviceUrl = new URL("../../apps/api/src/rework/rework-business-detail-service.ts", import.meta.url);
const routesUrl = new URL("../../apps/api/src/rework/routes.ts", import.meta.url);
const contractsUrl = new URL("../../packages/contracts/src/index.ts", import.meta.url);
const pageUrl = new URL("../../apps/web/src/rework-detail-page.tsx", import.meta.url);
const migrationUrl = new URL("../../apps/api/migrations/0116_tail_defective_quantity_ledger.sql", import.meta.url);
const manifestUrl = new URL("../../apps/api/src/platform/migration-manifest.json", import.meta.url);

describe("tail defective quantity ledger", () => {
  it("keeps receiving facts immutable and appends tail-stage entries with audit and idempotency", async () => {
    const service = await readFile(serviceUrl, "utf8");
    expect(service).toContain("rework_tail_defective_quantity_entries");
    expect(service).toContain("rework.tail_defective_quantity.add");
    expect(service).toContain("IdempotencyService");
    expect(service).toContain("OperationEventRepository");
    expect(service).toContain("tailDefectiveQuantity: previousTailQuantity + input.quantity");
    expect(service).not.toMatch(/UPDATE receiving_(?:batches|receipts)/);
  });

  it("only permits tail supervisors, owners and Root while every detail reader receives the split totals", async () => {
    const service = await readFile(serviceUrl, "utf8");
    expect(service).toContain('["tail_supervisor", "owner_group", "root_superuser"]');
    expect(service).toContain("只有尾部主管、老板或Root可以增加尾部次品数量");
    expect(service).toContain("receiving: Number(row.source_receiving_defective_quantity ?? 0)");
    expect(service).toContain("tail: Number(row.tail_defective_quantity ?? 0)");
    expect(service).toContain("tailEntries:");
  });

  it("validates the command at the route boundary and requires an idempotency key", async () => {
    const [routes, contracts] = await Promise.all([readFile(routesUrl, "utf8"), readFile(contractsUrl, "utf8")]);
    expect(contracts).toContain("AddTailDefectiveQuantitySchema");
    expect(routes).toContain('"/rework-orders/:reworkOrderId/tail-defective-quantity"');
    expect(routes).toContain("parse(AddTailDefectiveQuantitySchema, request.body)");
    expect(routes).toContain("idempotencyKey(request)");
  });

  it("shows total, receiving and tail values to all viewers and only renders add controls when authorized", async () => {
    const page = await readFile(pageUrl, "utf8");
    expect(page).toContain("总数 = 收货阶段 + 尾部阶段");
    expect(page).toContain("detail.defectiveQuantity.receiving");
    expect(page).toContain("detail.defectiveQuantity.tail");
    expect(page).toContain("detail.defectiveQuantity.total");
    expect(page).toContain("detail.defectiveQuantity.canAddTail");
    expect(page).toContain("tailEntries.map");
  });

  it("registers the append-only migration with its exact checksum", async () => {
    const [migration, manifestText] = await Promise.all([readFile(migrationUrl), readFile(manifestUrl, "utf8")]);
    const checksum = createHash("sha256").update(migration).digest("hex");
    const manifest = JSON.parse(manifestText) as { migrations: Array<{ version: string; checksum: string }> };
    expect(manifest.migrations).toContainEqual({ version: "0116_tail_defective_quantity_ledger", checksum });
    expect(migration.toString("utf8")).toContain("quantity integer NOT NULL CHECK (quantity > 0)");
  });
});
