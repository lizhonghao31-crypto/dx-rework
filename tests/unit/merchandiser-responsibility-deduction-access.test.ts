import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const migrationUrl = new URL("../../apps/api/migrations/0142_merchandiser_responsibility_deduction_access.sql", import.meta.url);
const manifestUrl = new URL("../../apps/api/src/platform/migration-manifest.json", import.meta.url);
const authorizedUrl = new URL("../../apps/api/src/rework/responsibility-determination-authorized-service.ts", import.meta.url);
const detailUrl = new URL("../../apps/web/src/rework-detail-page.tsx", import.meta.url);
const externalServiceUrl = new URL("../../apps/api/src/rework/external-responsibility-service.ts", import.meta.url);
const queueUrl = new URL("../../apps/web/src/external-responsibility-queue-page.tsx", import.meta.url);

describe("merchandiser responsibility and deduction access", () => {
  it("keeps N07 read-only and scopes visibility to either assigned merchandiser", async () => {
    const [authorized, detail] = await Promise.all([readFile(authorizedUrl, "utf8"), readFile(detailUrl, "utf8")]);
    expect(detail).toContain('hasCapability(currentUser, "rework:related_orders:view")');
    expect(authorized).toContain('caps.includes("rework:related_orders:view")');
    expect(authorized).toContain("order.merchandiser_user_id === actor.actorId");
    expect(authorized).toContain("order.embroidery_merchandiser_user_id === actor.actorId");
    expect(authorized).not.toContain('caps.includes("rework:related_orders:view") && pending');
  });

  it("grants deduction capabilities only through the matching live assignment", async () => {
    const migration = await readFile(migrationUrl, "utf8");
    expect(migration).toContain("('order_merchandiser','external_deduction:record')");
    expect(migration).toContain("('embroidery_washing_merchandiser','external_deduction:close')");
    expect(migration).toContain("order_record.merchandiser_user_id=candidate");
    expect(migration).toContain("supply.embroidery_merchandiser_user_id=candidate");
    expect(migration).not.toContain("business_handler_user_id=candidate");
  });

  it("checks each deduction action with its own capability", async () => {
    const service = await readFile(externalServiceUrl, "utf8");
    expect(service).toContain("external_responsibility_can_payables($1,$2,$3,$4)");
    expect(service).toContain('"external_deduction:record"');
    expect(service).toContain('"external_deduction:close"');
    expect(service).toContain("permitted.can_payables_confirm");
    expect(service).toContain("permitted.can_record");
  });

  it("shows explicit deduction status and a completed label", async () => {
    const queue = await readFile(queueUrl, "utf8");
    expect(queue).toContain("扣款状态");
    expect(queue).toContain('item.status === "closed" ? "已完成"');
    expect(queue).toContain('tone: item.overdue ? "danger" : item.canAct ? "warning" : "info"');
  });

  it("registers migration 0142 with its exact checksum", async () => {
    const [migration, manifestText] = await Promise.all([readFile(migrationUrl), readFile(manifestUrl, "utf8")]);
    const checksum = createHash("sha256").update(migration).digest("hex");
    const manifest = JSON.parse(manifestText) as { migrations: Array<{ version: string; checksum: string }> };
    expect(manifest.migrations).toContainEqual({ version: "0142_merchandiser_responsibility_deduction_access", checksum });
  });
});
