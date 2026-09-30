import { randomUUID } from "node:crypto";

import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { ReworkBusinessDetailService } from "../../apps/api/src/rework/rework-business-detail-service.js";
import type { TrustedActorContext } from "../../apps/api/src/tools/repositories.js";

const actor = (role: string): TrustedActorContext => ({
  actorId: randomUUID(),
  actorRoles: [role],
  authorizationCapability: "report:view",
  authorizationCapabilities: ["report:view"],
  requestId: randomUUID(),
});

describe("finance director rework detail access", () => {
  it("lets finance director open any non-deleted rework detail without waiting for wage facts", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const service = new ReworkBusinessDetailService({ query } as unknown as Pool);
    const row = {
      rework_order_id: randomUUID(),
      created_by: randomUUID(),
      merchandiser_user_id: null,
      embroidery_merchandiser_user_id: null,
    };
    const canView = (service as unknown as {
      canView(candidate: TrustedActorContext, detail: unknown): Promise<boolean>;
    }).canView.bind(service);

    await expect(canView(actor("finance_director"), row)).resolves.toBe(true);
    expect(query).not.toHaveBeenCalled();
  });

  it("aligns finance-read detail access with the director without waiting for wages", async () => {
    const query = vi.fn(async () => ({ rows: [] as unknown[] }));
    const service = new ReworkBusinessDetailService({ query } as unknown as Pool);
    const row = {
      rework_order_id: randomUUID(),
      created_by: randomUUID(),
      merchandiser_user_id: null,
      embroidery_merchandiser_user_id: null,
    };
    const canView = (service as unknown as {
      canView(candidate: TrustedActorContext, detail: unknown): Promise<boolean>;
    }).canView.bind(service);
    const financeRead = actor("finance_read");

    await expect(canView(financeRead, row)).resolves.toBe(true);
    expect(query).not.toHaveBeenCalled();
  });
});
