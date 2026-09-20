import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { ApplicationError } from "../../apps/api/src/platform/errors.js";
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

  it("keeps server composition on scoped authorization instead of an image-type bypass", async () => {
    const source = await readFile("apps/api/src/server.ts", "utf8");
    expect(source).not.toContain('["rework_order", "receiving_batch"].includes(binding.entityType)');
    expect(source).toContain("reworkBusinessDetailService.canDownloadBoundAttachment(businessReader, binding)");
    expect(source).toContain("reworkService.canDownloadBoundAttachment(actor, binding)");
  });
});
