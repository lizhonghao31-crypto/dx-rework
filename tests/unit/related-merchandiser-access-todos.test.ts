import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const reportingOrdersUrl = new URL("../../apps/api/src/reporting/management-reporting-orders.ts", import.meta.url);
const reportingServiceUrl = new URL("../../apps/api/src/reporting/management-reporting-service.ts", import.meta.url);
const detailServiceUrl = new URL("../../apps/api/src/rework/rework-business-detail-service.ts", import.meta.url);
const responsibilityUrl = new URL("../../apps/api/src/rework/responsibility-determination-service.ts", import.meta.url);
const authorizedResponsibilityUrl = new URL("../../apps/api/src/rework/responsibility-determination-authorized-service.ts", import.meta.url);
const wholeOrderUrl = new URL("../../apps/api/src/rework/whole-order-review-service.ts", import.meta.url);
const shellUrl = new URL("../../apps/web/src/components.tsx", import.meta.url);
const appUrl = new URL("../../apps/web/src/App.tsx", import.meta.url);
const presentationUrl = new URL("../../packages/contracts/src/todo-presentation.ts", import.meta.url);
const migrationUrl = new URL("../../apps/api/migrations/0117_related_merchandiser_rework_access.sql", import.meta.url);
const manifestUrl = new URL("../../apps/api/src/platform/migration-manifest.json", import.meta.url);

describe("related merchandiser access and N07 notifications", () => {
  it("grants a dedicated capability without granting global report access", async () => {
    const migration = await readFile(migrationUrl, "utf8");
    expect(migration).toContain("rework:related_orders:view");
    expect(migration).toContain("order_merchandiser");
    expect(migration).toContain("embroidery_washing_merchandiser");
    expect(migration).not.toContain("report:view");
  });

  it("scopes the list to either directly assigned merchandiser relationship", async () => {
    const [orders, service] = await Promise.all([
      readFile(reportingOrdersUrl, "utf8"),
      readFile(reportingServiceUrl, "utf8"),
    ]);
    expect(service).toContain('currentCapabilities.includes("rework:related_orders:view")');
    expect(service).toContain("relatedOrderActorUserId: actor.actorId");
    expect(orders).toContain("order_record.merchandiser_user_id");
    expect(orders).toContain("related_supply.embroidery_merchandiser_user_id");
  });

  it("allows the assigned embroidery merchandiser to open the same order detail", async () => {
    const detail = await readFile(detailServiceUrl, "utf8");
    expect(detail).toContain("supply_context.embroidery_merchandiser_user_id");
    expect(detail).toContain("row.embroidery_merchandiser_user_id === actor.actorId");
  });

  it("exposes only the related-order board entry to scoped merchandisers", async () => {
    const [shell, app] = await Promise.all([readFile(shellUrl, "utf8"), readFile(appUrl, "utf8")]);
    expect(shell).toContain('hasCapability("rework:related_orders:view")');
    expect(app).toContain('{ requiredCapability: "rework:related_orders:view" }');
  });

  it("creates independent N07 todos for every production manager and closes them on takeover", async () => {
    const [wholeOrder, responsibility] = await Promise.all([
      readFile(wholeOrderUrl, "utf8"),
      readFile(responsibilityUrl, "utf8"),
    ]);
    expect(wholeOrder).toContain("actionableForAllDirectRole");
    expect(wholeOrder).toContain('requiredRole: "production_management"');
    expect(wholeOrder).toContain('requiredCapability: "responsibility:determine"');
    expect(responsibility).toContain('responsibility-entry:');
    expect(responsibility).toContain("A production manager took responsibility for N07");
  });

  it("wires both assigned merchandisers into the production finalizer", async () => {
    const [authorized, presentation] = await Promise.all([
      readFile(authorizedResponsibilityUrl, "utf8"),
      readFile(presentationUrl, "utf8"),
    ]);
    expect(authorized).toContain("await this.notifyMerchandisers(");
    expect(authorized).toContain("order.merchandiser_user_id");
    expect(authorized).toContain("order.embroidery_merchandiser_user_id");
    expect(authorized).toContain('category: "responsibility_finalized_notice"');
    expect(authorized).toContain("new Set([");
    expect(presentation).toContain("返工责任判定已完成");
  });

  it("registers migration 0117 with its exact checksum", async () => {
    const [migration, manifestText] = await Promise.all([readFile(migrationUrl), readFile(manifestUrl, "utf8")]);
    const checksum = createHash("sha256").update(migration).digest("hex");
    const manifest = JSON.parse(manifestText) as { migrations: Array<{ version: string; checksum: string }> };
    expect(manifest.migrations).toContainEqual({ version: "0117_related_merchandiser_rework_access", checksum });
  });
});
