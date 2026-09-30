import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { TodoService } from "../../apps/api/src/todos/service.js";

const actor = {
  actorId: "00000000-0000-4000-8000-000000000016",
  actorRoles: ["tail_supervisor"],
  authorizationCapability: "todo:view",
  authorizationCapabilities: ["todo:view"],
  requestId: "todo-indicator-test",
} as const;

describe("todo count indicator", () => {
  it("counts every current actionable todo assigned to the actor", async () => {
    const query = vi.fn(async () => ({ rows: [{ pending_count: "4" }] }));
    const service = new TodoService({ query } as unknown as Pool);

    await expect(service.countIndicatorForActor(actor)).resolves.toEqual({
      pendingCount: 4,
    });
    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain("todos.recipient_user_id=$1");
    expect(sql).toContain("todos.status IN ('pending','blocked_recipient')");
    expect(sql).toContain("todos.todo_type<>'information'");
    expect(sql).toContain("todos.category<>'wage_month_close'");
    expect(sql).toContain("orders.status<>'deleted'");
  });

  it("returns zero when the actor has no actionable todo", async () => {
    const service = new TodoService({
      query: vi.fn(async () => ({ rows: [{ pending_count: "0" }] })),
    } as unknown as Pool);

    await expect(service.countIndicatorForActor(actor)).resolves.toEqual({
      pendingCount: 0,
    });
  });
});
