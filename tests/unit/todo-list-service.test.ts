import { describe, expect, it, vi } from "vitest";

import type { Pool } from "pg";

import { TodoService } from "../../apps/api/src/todos/service.js";

describe("todo list query", () => {
  it("searches all authorized modules and preserves direct numeric pagination", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({rows:[{relation:null}]})
      .mockResolvedValueOnce({ rows: [{ todo_module: "rework", todo_count: "16" }] })
      .mockResolvedValueOnce({
        rows: [{total_count:16,total_pages:2,page:2,items:[{kind:"database",value:{
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
        }}]}],
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

    const countSql = String(query.mock.calls[1]![0]);
    const searchSql = String(query.mock.calls[2]![0]);
    expect(countSql).toContain("LEFT JOIN supplier_catalog_versions rework_supplier");
    expect(searchSql).toContain("recipient_user_id=$1");
    expect(searchSql).toContain("COALESCE(supplier_name_snapshot,'')");
    expect(searchSql).toContain("UNION ALL");
    expect(searchSql).toContain("LIMIT 15 OFFSET");
    expect(searchSql).not.toContain("todo_module=$2");
    expect(query.mock.calls).toHaveLength(3);
    expect(query.mock.calls[2]![1]).toEqual(["00000000-0000-4000-8000-000000000016","嘉顺","[]",2,expect.any(String)]);
    expect(result.searchScope).toBe("all");
  });
});
