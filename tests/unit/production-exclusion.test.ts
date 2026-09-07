import { describe, expect, it, vi } from "vitest";
import { ProductionExclusionInputSchema, type ProductionExclusionPreview } from "@dx-rework/contracts";
import { ProductionExclusionService, productionExclusionVersion, validateProductionExclusion } from "../../apps/api/src/sourcing/production-exclusion-service.js";
import type { Pool } from "pg";
import type { TrustedActorContext } from "../../apps/api/src/tools/repositories.js";
vi.mock("../../apps/api/src/tools/repositories.js", () => ({ IdempotencyService: class {}, OperationEventRepository: class {} }));
const id = "00000000-0000-4000-8000-000000000100";
const preview = { order: { productionOrderId: id }, version: "a".repeat(64), exclusion: null } as ProductionExclusionPreview;
const input = { expectedVersion: preview.version, confirmedProductionOrderId: id, reason: "合成测试", confirmed: true as const };
describe("production exclusion safety", () => {
  it("rejects non-Root reads and writes before opening the database", async () => {
    const connect = vi.fn(), service = new ProductionExclusionService({ connect } as unknown as Pool);
    const actor = { actorId: id, actorRoles: ["owner_group", "production_management"], authorizationCapability: "sourcing:view", requestId: "test" } as TrustedActorContext;
    await expect(service.preview(actor, id)).rejects.toMatchObject({ statusCode: 403 });
    await expect(service.exclude(actor, id, input, "test-key")).rejects.toMatchObject({ statusCode: 403 });
    expect(connect).not.toHaveBeenCalled();
  });
  it("requires explicit confirmation, reason, exact ID and unchanged preview", () => {
    expect(ProductionExclusionInputSchema.safeParse(input).success).toBe(true);
    for (const field of [{ reason: " " }, { confirmed: false }, { expectedVersion: "old" }]) expect(ProductionExclusionInputSchema.safeParse({ ...input, ...field }).success).toBe(false);
    expect(() => validateProductionExclusion(preview, input)).not.toThrow();
    expect(() => validateProductionExclusion(preview, { ...input, confirmedProductionOrderId: "00000000-0000-4000-8000-000000000101" })).toThrow(/对象/);
    expect(() => validateProductionExclusion(preview, { ...input, expectedVersion: "b".repeat(64) })).toThrow(/变化/);
    expect(() => validateProductionExclusion({ ...preview, exclusion: { reason: "已排除", excludedBy: id, excludedAt: "2026-09-07T00:00:00Z", operationEventId: id } }, input)).toThrow(/已排除/);
  });
  it("changes the preview version for new execution or receipt evidence", () => {
    const facts = { id, report_ids: ["original"], receipt_ids: [] };
    expect(productionExclusionVersion(facts)).toBe(productionExclusionVersion({ ...facts }));
    expect(productionExclusionVersion({ ...facts, report_ids: ["original", "correction"] })).not.toBe(productionExclusionVersion(facts));
    expect(productionExclusionVersion({ ...facts, receipt_ids: ["new-receipt"] })).not.toBe(productionExclusionVersion(facts));
  });
});
