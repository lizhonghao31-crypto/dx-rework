import { readFile } from "node:fs/promises";

import { AdminExceptionsPageSchema } from "@dx-rework/contracts/admin-console";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { AdminConsoleService } from "../../apps/api/src/admin-console-service.js";

describe("Root UAT PR-04 exception traceability", () => {
  it("returns order, action, stage, request and status facts while redacting private values", async () => {
    const reworkOrderId = "00000000-0000-4000-8000-000000000021";
    const query = vi.fn().mockResolvedValue({ rows: [{
      created_at: new Date("2026-08-25T02:00:00.000Z"),
      id: "00000000-0000-4000-8000-000000000022",
      exception_type: "todo_delivery_failed",
      source_entity_type: "todo_delivery_attempt",
      source_entity_id: "00000000-0000-4000-8000-000000000022",
      rework_order_id: reworkOrderId,
      business_action: "responsibility_confirmation",
      failure_stage: "钉钉待办投递",
      request_id: "request-trace-123",
      status: "failed",
      occurred_at: new Date("2026-08-25T02:00:00.000Z"),
      last_updated_at: new Date("2026-08-25T02:01:00.000Z"),
      safe_error: "phone=13900139000 id=440106199101011234 app_secret=do-not-show",
      retryable: false,
      deep_link: `/ui/tasks/${reworkOrderId}`,
      details: { deliveryKind: "create", version: 0 },
    }] });
    const service = new AdminConsoleService({ query } as unknown as Pool);

    const page = await service.exceptions({ limit: 50 });

    expect(AdminExceptionsPageSchema.parse(page).items[0]).toMatchObject({
      reworkOrderId,
      businessAction: "responsibility_confirmation",
      failureStage: "钉钉待办投递",
      requestId: "request-trace-123",
      status: "failed",
      deepLink: `/ui/tasks/${reworkOrderId}`,
    });
    expect(page.items[0]?.safeError).toContain("[PHONE REDACTED]");
    expect(page.items[0]?.safeError).toContain("[IDENTITY REDACTED]");
    expect(page.items[0]?.safeError).toContain("[REDACTED]");
    expect(page.items[0]?.safeError).not.toContain("13900139000");
    expect(page.items[0]?.safeError).not.toContain("440106199101011234");
    expect(page.items[0]?.safeError).not.toContain("do-not-show");

    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain("operation_request_id");
    expect(sql).toContain("rework_order_id");
    expect(sql).toContain("latest_binding_event");
  });

  it("shows a copyable response request ID and a direct linked-order action in the existing page", async () => {
    const page = await readFile("apps/web/src/admin-console-page.tsx", "utf8");

    expect(page).toContain('body?.error?.requestId ?? response.headers.get("x-request-id")');
    expect(page).toContain("navigator.clipboard.writeText(value)");
    expect(page).toContain("复制请求 ID");
    expect(page).toContain("关联订单：");
    expect(page).toContain("进入返工单");
    expect(page).toContain("业务动作：");
    expect(page).toContain("失败阶段：");
    expect(page).toContain("最近错误：");
    expect(page).toContain("处理状态：");
  });
});
