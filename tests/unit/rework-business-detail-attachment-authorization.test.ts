import { randomUUID } from "node:crypto";

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
});
