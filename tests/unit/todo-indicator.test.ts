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

describe("todo new indicator", () => {
  it("uses the current recipient's latest transfer time as the arrival marker", async () => {
    const receivedAt = new Date("2026-09-01T04:00:00.000Z");
    const query = vi.fn(async () => ({
      rows: [{
        todo_id: "00000000-0000-4000-8000-000000000013",
        received_at: receivedAt,
      }],
    }));
    const service = new TodoService({ query } as unknown as Pool);

    await expect(service.latestIndicatorForActor(actor)).resolves.toEqual({
      latestTodoId: "00000000-0000-4000-8000-000000000013",
      latestReceivedAt: receivedAt.toISOString(),
    });
    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain("FROM todo_recipient_transfers transfer");
    expect(sql).toContain("transfer.to_recipient_user_id=todos.recipient_user_id");
    expect(sql).toContain("COALESCE(latest_transfer.transferred_at,todos.created_at) received_at");
    expect(sql).toContain("ORDER BY received_at DESC,todos.todo_id DESC");
  });

  it("returns an empty marker when the actor has no actionable todo", async () => {
    const service = new TodoService({
      query: vi.fn(async () => ({ rows: [] })),
    } as unknown as Pool);

    await expect(service.latestIndicatorForActor(actor)).resolves.toEqual({
      latestTodoId: null,
      latestReceivedAt: null,
    });
  });
});
