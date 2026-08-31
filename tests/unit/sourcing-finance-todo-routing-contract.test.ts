import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import { TodoProjectionService } from "../../apps/api/src/todos/projection-service.js";

describe("sourcing finance confirmation and explicit-role todo routing", () => {
  it("routes sourcing business todos from assignments without implicit Root recipients", async () => {
    const createInTransaction = vi.fn(async () => undefined);
    const projection = new TodoProjectionService({ createInTransaction } as never);
    const query = vi.fn(async (sql: string) => {
      expect(sql).toContain("FROM user_role_assignments assignment");
      expect(sql).not.toContain("owner_bootstrap_consumptions");
      return { rows: [{ user_id: "00000000-0000-4000-8000-000000000501" }] };
    });

    const recipients = await projection.actionableForAllAssignedRole(
      { query } as never,
      {
        actorId: "00000000-0000-4000-8000-000000000001",
        actorRoles: ["owner_group"],
        authorizationCapability: "sourcing:owner:approve",
        requestId: "sourcing-explicit-role-test",
      },
      {
        category: "sourcing_finance_reconcile",
        sourceEventId: "00000000-0000-4000-8000-000000000010",
        sourceAction: "sourcing.owner.approve",
        entityType: "sourcing_case",
        entityId: "00000000-0000-4000-8000-000000000100",
        requiredRole: "factory_payables",
        requiredCapability: "sourcing:finance:reconcile",
        route: {
          routeName: "sourcing_detail",
          entityId: "00000000-0000-4000-8000-000000000100",
        },
        policyKey: "general",
        dedupeKey: "sourcing:case:finance:1:1",
      },
    );

    expect(recipients).toEqual(["00000000-0000-4000-8000-000000000501"]);
    expect(createInTransaction).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        recipientUserId: "00000000-0000-4000-8000-000000000501",
        requiredRole: "factory_payables",
        requiredCapability: "sourcing:finance:reconcile",
        dedupeKey:
          "sourcing:case:finance:1:1:00000000-0000-4000-8000-000000000501",
      }),
    );
  });

  it("uses the explicit-role router for every sourcing business todo", async () => {
    const service = await readFile("apps/api/src/sourcing/sourcing-service.ts", "utf8");
    expect(service.match(/actionableForAllAssignedRole\(/g)).toHaveLength(11);
    expect(service).not.toContain("todoProjection?.actionableForAllDirectRole(");
  });

  it("cancels only implicit Root sourcing todos and preserves their audit facts", async () => {
    const migration = await readFile(
      "apps/api/migrations/0123_sourcing_explicit_role_todos.sql",
      "utf8",
    );
    expect(migration).toContain("todo.entity_type='sourcing_case'");
    expect(migration).toContain("todo.recipient_user_id=root_user_id");
    expect(migration).toContain("FROM user_role_assignments assignment");
    expect(migration).toContain("assignment.role_code=todo.required_role");
    expect(migration).toContain("'todo.cancel'");
    expect(migration).toContain("cancelled_operation_event_id=cancellation_event_id");
    expect(migration).not.toContain("DELETE FROM rework_todos");
  });

  it("presents finance as the confirming role instead of another submit handoff", async () => {
    const page = await readFile("apps/web/src/sourcing-workspace-page.tsx", "utf8");
    const title = page.indexOf("<h2>05 · 财务核对</h2>");
    const approvedFacts = page.indexOf('className="sourcing-finance-reference"', title);
    const form = page.indexOf('className="sourcing-form-grid"', approvedFacts);
    expect(title).toBeGreaterThan(-1);
    expect(approvedFacts).toBeGreaterThan(title);
    expect(form).toBeGreaterThan(approvedFacts);
    expect(page).toContain("批准加工厂");
    expect(page).toContain("批准单价");
    expect(page).toContain("批准数量");
    expect(page).toContain("批准总额");
    expect(page).toContain("确认核对结果");
    expect(page).not.toContain(")}>提交财务核对</button>");
  });
});
