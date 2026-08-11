import type { PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";

import { TodoProjectionService } from "../../apps/api/src/todos/projection-service.js";
import type { TodoService } from "../../apps/api/src/todos/service.js";
import type { TrustedActorContext } from "../../apps/api/src/tools/repositories.js";

const actor: TrustedActorContext = {
  actorId: "00000000-0000-4000-8000-000000000001",
  actorRoles: ["owner_group"],
  authorizationCapability: "own_factory:approve",
  requestId: "owner-group-routing-test",
};

const projection = {
  category: "own_factory_approval",
  sourceEventId: "00000000-0000-4000-8000-000000000002",
  sourceAction: "rework.own_factory_approval.create",
  entityType: "rework_order",
  entityId: "00000000-0000-4000-8000-000000000003",
  requiredRole: "owner_group",
  requiredCapability: "own_factory:approve",
  route: {
    routeName: "own_factory_approval" as const,
    entityId: "00000000-0000-4000-8000-000000000003",
  },
  policyKey: "general" as const,
  dedupeKey: "own-factory-approval:shared",
};

describe("shared owner-group todo routing", () => {
  it("creates one independently deduplicated todo for every eligible direct owner", async () => {
    const owners = [
      "00000000-0000-4000-8000-000000000011",
      "00000000-0000-4000-8000-000000000012",
      "00000000-0000-4000-8000-000000000013",
    ];
    const client = {
      query: vi.fn(async () => ({
        rows: owners.map((user_id) => ({ user_id })),
      })),
    } as unknown as PoolClient;
    const createInTransaction = vi.fn(async (...arguments_: unknown[]) => {
      void arguments_;
      return undefined;
    });
    const service = new TodoProjectionService({
      createInTransaction,
    } as unknown as TodoService);

    await expect(service.actionableForAllDirectRole(
      client,
      actor,
      projection,
    )).resolves.toEqual(owners);

    expect(String((client.query as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]))
      .not.toContain("LIMIT");
    expect(String((client.query as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]))
      .toContain("owner_bootstrap_consumptions");
    expect(createInTransaction).toHaveBeenCalledTimes(3);
    const createCalls = createInTransaction.mock.calls as unknown as Array<[
      PoolClient,
      TrustedActorContext,
      { dedupeKey: string },
    ]>;
    expect(createCalls.map((call) => call[2].dedupeKey))
      .toEqual(owners.map((owner) => `${projection.dedupeKey}:${owner}`));
  });

  it("fails closed when a shared owner node has no eligible direct owner", async () => {
    const client = {
      query: vi.fn(async () => ({ rows: [] })),
    } as unknown as PoolClient;
    const service = new TodoProjectionService({
      createInTransaction: vi.fn(),
    } as unknown as TodoService);

    await expect(service.actionableForAllDirectRole(client, actor, projection))
      .rejects.toMatchObject({ code: "CONFLICT", statusCode: 409 });
  });
});
