import { describe, expect, it, vi } from "vitest";

import type { Pool } from "pg";

import { TodoService } from "../../apps/api/src/todos/service.js";

describe("todo list query", () => {
  it("searches the rework processing supplier and serves direct numeric pages", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ todo_module: "rework", todo_count: "16" }] })
      .mockResolvedValueOnce({ rows: [{ total_count: "16" }] })
      .mockResolvedValueOnce({
        rows: [{
          todo_id: "00000000-0000-4000-8000-000000000013",
          todo_type: "business_action",
          category: "responsibility_determination",
          source_event_id: "00000000-0000-4000-8000-000000000014",
          source_action: "rework.responsibility.pending",
          entity_type: "rework_order",
          entity_id: "00000000-0000-4000-8000-000000000015",
          recipient_user_id: "00000000-0000-4000-8000-000000000016",
          required_role: "production_management",
          required_capability: "responsibility:determine",
          delegation_id: null,
          delegation_scope_id: null,
          route_descriptor: {
            routeName: "responsibility_detail",
            entityId: "00000000-0000-4000-8000-000000000015",
            todoId: "00000000-0000-4000-8000-000000000013",
          },
          policy_key: "general",
          due_at: null,
          reminder_count: 0,
          status: "pending",
          blocked_reason: null,
          rework_no: "RW-2026-0831-001",
          order_no: null,
          style_no: "IN20541804",
          rework_status: "pending_responsibility",
          rework_updated_at: new Date("2026-09-01T00:00:00.000Z"),
          sourcing_order_no: null,
          sourcing_style_no: null,
          sourcing_status: null,
          sourcing_updated_at: null,
          supplier_name_snapshot: "嘉顺",
          version: 1,
          created_at: new Date("2026-09-01T00:00:00.000Z"),
          updated_at: new Date("2026-09-01T00:00:00.000Z"),
          status_rank: 0,
          todo_module: "rework",
        }],
      });
    const service = new TodoService({ query } as unknown as Pool);

    const result = await service.listForActor({
      actorId: "00000000-0000-4000-8000-000000000016",
      actorRoles: ["production_management"],
      authorizationCapability: "todo:view",
      authorizationCapabilities: ["todo:view"],
      requestId: "todo-list-query",
    }, {
      module: "rework",
      query: "嘉顺",
      page: 2,
    });

    expect(result).toMatchObject({
      activeModule: "rework",
      moduleCounts: { rework: 16, sourcing: 0 },
      page: 2,
      pageSize: 15,
      totalCount: 16,
      totalPages: 2,
      todos: [{ orderContext: { supplierName: "嘉顺", styleNo: "IN20541804" } }],
    });

    const countSql = String(query.mock.calls[0]![0]);
    const totalSql = String(query.mock.calls[1]![0]);
    const pageSql = String(query.mock.calls[2]![0]);
    expect(countSql).toContain("LEFT JOIN supplier_catalog_versions rework_supplier");
    expect(countSql).toContain("rework_supplier.version=orders.processing_factory_supplier_version");
    expect(countSql).toContain("orders.processing_factory_type='own_factory'");
    expect(totalSql).toContain("COALESCE(supplier_name_snapshot,'')");
    expect(query.mock.calls[1]![1]).toEqual([
      "00000000-0000-4000-8000-000000000016",
      "rework",
      "嘉顺",
    ]);
    expect(pageSql).toContain("LIMIT $4 OFFSET $5");
    expect(query.mock.calls[2]![1]).toEqual([
      "00000000-0000-4000-8000-000000000016",
      "rework",
      "嘉顺",
      15,
      15,
    ]);
  });
});
