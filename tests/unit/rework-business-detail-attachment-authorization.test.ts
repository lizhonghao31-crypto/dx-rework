import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { ApplicationError } from "../../apps/api/src/platform/errors.js";
import { ReceivingService } from "../../apps/api/src/receiving/receiving-service.js";
import { ReworkBusinessDetailService } from "../../apps/api/src/rework/rework-business-detail-service.js";
import type { TrustedActorContext } from "../../apps/api/src/tools/repositories.js";

const actor: TrustedActorContext = {
  actorId: randomUUID(),
  actorRoles: ["quality_control"],
  authorizationCapability: "rework:view",
  authorizationCapabilities: ["rework:view"],
  requestId: randomUUID(),
};

describe("receiving attachment authorization", () => {
  it("allows access when the actor can view any non-deleted rework linked to the batch", async () => {
    const olderOrderId = randomUUID();
    const newerOrderId = randomUUID();
    const database = {
      query: vi.fn(async () => ({
        rows: [{ rework_order_id: newerOrderId }, { rework_order_id: olderOrderId }],
      })),
    } as unknown as Pool;
    const service = new ReworkBusinessDetailService(database);
    const get = vi.spyOn(service, "get")
      .mockRejectedValueOnce(new ApplicationError("FORBIDDEN", "forbidden", 403))
      .mockResolvedValueOnce({canReadBusinessDetails:true} as Awaited<ReturnType<ReworkBusinessDetailService["get"]>>);

    await expect(service.canDownloadBoundAttachment(actor, {
      entityType: "receiving_batch",
      entityId: randomUUID(),
    })).resolves.toBe(true);
    expect(get).toHaveBeenCalledTimes(2);
    expect(get).toHaveBeenLastCalledWith(actor, olderOrderId);
  });
  it("denies access when the actor cannot view any rework linked to the receiving batch", async () => {
    const linkedOrderId = randomUUID();
    const database = {
      query: vi.fn(async () => ({ rows: [{ rework_order_id: linkedOrderId }] })),
    } as unknown as Pool;
    const service = new ReworkBusinessDetailService(database);
    const get = vi.spyOn(service, "get")
      .mockRejectedValue(new ApplicationError("FORBIDDEN", "forbidden", 403));

    await expect(service.canDownloadBoundAttachment(actor, {
      entityType: "receiving_batch",
      entityId: randomUUID(),
      mimeType: "image/jpeg",
    })).resolves.toBe(false);
    expect(get).toHaveBeenCalledWith(actor, linkedOrderId);
  });

  it("authorizes active receipt evidence for an effective business role without reopening the MIME bypass", async () => {
    const query = vi.fn(async () => ({ rows: [{ permitted: true }] }));
    const service = new ReceivingService({ query } as unknown as Pool);

    await expect(service.canDownloadBoundAttachment(
      { actorRoles: ["warehouse_receiver"] },
      { attachmentId: randomUUID(), entityType: "receiving_batch", entityId: randomUUID(), mimeType: "image/jpeg" },
    )).resolves.toBe(true);
    expect(String(query.mock.calls[0]?.[0])).toContain("receiving_attachment_retirements");

    await expect(service.canDownloadBoundAttachment(
      { actorRoles: [] },
      { attachmentId: randomUUID(), entityType: "receiving_batch", entityId: randomUUID(), mimeType: "image/jpeg" },
    )).resolves.toBe(false);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("keeps server composition on scoped authorization instead of an image-type bypass", async () => {
    const source = await readFile("apps/api/src/server.ts", "utf8");
    expect(source).not.toContain('["rework_order", "receiving_batch"].includes(binding.entityType)');
    expect(source).toContain("receivingService.canDownloadBoundAttachment(businessReader, binding)");
    expect(source).toContain("reportingService.canDownloadBasicReworkAttachment(businessReader, binding)");
    expect(source).toContain("reworkBusinessDetailService.canDownloadBoundAttachment(businessReader, binding)");
    expect(source).toContain("actor.actorRoles.includes(ROOT_ACTOR_ROLE)");
    expect(source).toContain('binding.entityType === "rework_order" || binding.entityType === "receiving_batch"');
  });
});
