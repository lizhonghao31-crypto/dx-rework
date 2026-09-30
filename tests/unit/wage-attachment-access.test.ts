import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { canDownloadWageAttachment } from "../../apps/api/src/wages/wage-attachment-access.js";

const database = (requestedBy: string | null) => ({
  query: vi.fn().mockResolvedValue({
    rows: requestedBy ? [{ requested_by: requestedBy }] : [],
  }),
}) as unknown as Pool;

describe("wage adjustment attachment access", () => {
  it("allows only the direct requester and administrative approver", async () => {
    const requesterDatabase = database("tail-1");
    await expect(canDownloadWageAttachment(
      requesterDatabase,
      {
        actorId: "tail-1",
        actorRoles: ["tail_supervisor"],
        capabilities: ["wage:adjustment_request", "tools:user"],
      },
      { entityType: "wage_adjustment", entityId: "adjustment-1" },
    )).resolves.toBe(true);

    await expect(canDownloadWageAttachment(
      database("tail-1"),
      {
        actorId: "tail-2",
        actorRoles: ["tail_supervisor"],
        capabilities: ["wage:adjustment_request", "tools:user"],
      },
      { entityType: "wage_adjustment", entityId: "adjustment-1" },
    )).resolves.toBe(false);

    await expect(canDownloadWageAttachment(
      database("tail-1"),
      {
        actorId: "admin-1",
        actorRoles: ["administrative_clerk"],
        capabilities: ["wage:adjustment_approve", "tools:user"],
      },
      { entityType: "wage_adjustment", entityId: "adjustment-1" },
    )).resolves.toBe(true);

    await expect(canDownloadWageAttachment(
      database("tail-1"),
      {
        actorId: "system-admin",
        actorRoles: ["system_admin"],
        capabilities: [
          "wage:adjustment_request",
          "wage:adjustment_approve",
          "tools:user",
        ],
      },
      { entityType: "wage_adjustment", entityId: "adjustment-1" },
    )).resolves.toBe(false);
  });

  it("ignores non-wage bindings without querying wage data", async () => {
    const target = database("tail-1");
    await expect(canDownloadWageAttachment(
      target,
      {
        actorId: "tail-1",
        actorRoles: ["tail_supervisor"],
        capabilities: ["wage:adjustment_request", "tools:user"],
      },
      { entityType: "rework_order", entityId: "order-1" },
    )).resolves.toBe(false);
    expect(target.query).not.toHaveBeenCalled();
  });
});
