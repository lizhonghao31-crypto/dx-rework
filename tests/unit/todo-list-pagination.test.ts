import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { TodoService } from "../../apps/api/src/todos/service.js";
import type { TrustedActorContext } from "../../apps/api/src/tools/repositories.js";

const actor: TrustedActorContext = {
  actorId: "00000000-0000-4000-8000-000000000001",
  actorRoles: ["tail_supervisor"],
  authorizationCapability: "todo:view",
  authorizationCapabilities: ["todo:view"],
  requestId: "todo-list-pagination",
};

const row = (index: number) => {
  const todoId = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
  return {
    todo_id: todoId,
    todo_type: "business_action",
    category: "process_configuration",
    source_event_id: "00000000-0000-4000-8000-000000000100",
    source_action: "rework.pending_process_configuration",
    entity_type: "rework_order",
    entity_id: "00000000-0000-4000-8000-000000000200",
    recipient_user_id: actor.actorId,
    required_role: "tail_supervisor",
    required_capability: "process:configure",
    delegation_scope_id: null,
    route_descriptor: {
      routeName: "process_configuration",
      entityId: "00000000-0000-4000-8000-000000000200",
      todoId,
    },
    policy_key: "general",
    due_at: null,
    reminder_count: 0,
    status: "pending",
    blocked_reason: null,
    version: 1,
    created_at: new Date(Date.UTC(2026, 8, 30, 0, 0, 30 - index)),
    updated_at: new Date(Date.UTC(2026, 8, 30, 0, 0, 30 - index)),
    rework_no: "RW-001",
    order_no: "PO-001",
    style_no: "STYLE-001",
    rework_status: "pending_process_configuration",
    rework_updated_at: new Date("2026-09-30T00:00:00.000Z"),
    sourcing_order_no: null,
    sourcing_style_no: null,
    sourcing_status: null,
    sourcing_updated_at: null,
    supplier_name_snapshot: null,
    todo_module: "rework",
    status_rank: 0,
  };
};

describe("my todo pagination", () => {
  it("returns 15 actionable todos, module counts and a stable next cursor", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ todo_module: "rework", todo_count: "16" }] })
      .mockResolvedValueOnce({ rows: Array.from({ length: 16 }, (_, index) => row(index + 1)) })
      .mockResolvedValueOnce({ rows: [{ todo_module: "rework", todo_count: "16" }] })
      .mockResolvedValueOnce({ rows: [row(16)] });
    const service = new TodoService({ query } as unknown as Pool);

    const first = await service.listForActor(actor, { module: "rework", query: "STYLE" });
    expect(first.todos).toHaveLength(15);
    expect(first.moduleCounts).toEqual({ rework: 16, sourcing: 0, wages: 0 });
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(query.mock.calls[1]?.[0]).toContain("LIMIT 16");

    const second = await service.listForActor(actor, {
      module: "rework",
      query: "STYLE",
      cursor: first.nextCursor ?? "",
    });
    expect(second.todos).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect(query.mock.calls[3]?.[1]).toEqual([
      actor.actorId,
      "rework",
      "STYLE",
      0,
      null,
      row(15).created_at.toISOString(),
      row(15).todo_id,
    ]);
  });

  it("rejects a cursor bound to another query before loading a page", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ todo_module: "rework", todo_count: 16 }] })
      .mockResolvedValueOnce({ rows: Array.from({ length: 16 }, (_, index) => row(index + 1)) })
      .mockResolvedValueOnce({ rows: [{ todo_module: "rework", todo_count: 16 }] });
    const service = new TodoService({ query } as unknown as Pool);
    const first = await service.listForActor(actor, { module: "rework", query: "STYLE" });

    await expect(service.listForActor(actor, {
      module: "rework",
      query: "OTHER",
      cursor: first.nextCursor ?? "",
    })).rejects.toMatchObject({ code: "VALIDATION_ERROR", statusCode: 400 });
    expect(query).toHaveBeenCalledTimes(3);
  });
});
