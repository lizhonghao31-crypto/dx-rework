import type { PoolClient } from "pg";
import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";

import { RootAwareTodoProjectionService } from "../../apps/api/src/todos/root-aware-projection-service.js";
import type { TodoService } from "../../apps/api/src/todos/service.js";
import type { TrustedActorContext } from "../../apps/api/src/tools/repositories.js";

const projection = {
  category: "responsibility_determination",
  sourceEventId: "00000000-0000-4000-8000-000000000002",
  sourceAction: "rework.whole_order.approve",
  entityType: "rework_order",
  entityId: "00000000-0000-4000-8000-000000000003",
  requiredRole: "production_management",
  requiredCapability: "responsibility:determine",
  route: {
    routeName: "responsibility_detail" as const,
    entityId: "00000000-0000-4000-8000-000000000003",
  },
  policyKey: "general" as const,
  dedupeKey: "responsibility-entry:test",
};

const actor = (root: boolean): TrustedActorContext => ({
  actorId: "00000000-0000-4000-8000-000000000001",
  actorRoles: root ? ["root_superuser"] : ["tail_supervisor"],
  authorizationCapability: "submission:audit",
  requestId: root ? "root-responsibility-routing" : "ordinary-responsibility-routing",
});

describe("N07 responsibility todo routing", () => {
  it("keeps a Root-authored transition valid without manufacturing a Root todo", async () => {
    const client = { query: vi.fn(async () => ({ rows: [] })) } as unknown as PoolClient;
    const service = new RootAwareTodoProjectionService({
      createInTransaction: vi.fn(),
    } as unknown as TodoService);

    await expect(service.actionableForAllAssignedRole(client, actor(true), projection))
      .resolves.toEqual([]);
    expect(String((client.query as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]))
      .not.toContain("owner_bootstrap_consumptions");
    await expect(service.actionableForAllAssignedRole(client, actor(false), projection))
      .rejects.toMatchObject({ code: "CONFLICT", statusCode: 409 });
  });

  it("routes both N07 entry paths through explicit assignees and repairs old Root todos", async () => {
    const [review, migration] = await Promise.all([
      readFile("apps/api/src/rework/whole-order-review-service.ts", "utf8"),
      readFile("apps/api/migrations/0131_responsibility_todo_explicit_assignees.sql", "utf8"),
    ]);
    expect(review.match(/actionableForAllAssignedRole/g)).toHaveLength(2);
    expect(review).not.toContain("actionableForAllDirectRole");
    expect(migration).toContain("dedupe_key LIKE 'responsibility-entry:%'");
    expect(migration).toContain("assignment.role_code='production_management'");
    expect(migration).toContain("implicitRootRecipient");
  });
});
