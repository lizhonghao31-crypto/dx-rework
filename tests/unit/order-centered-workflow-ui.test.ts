import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("order-centered workflow UI", () => {
  it("keeps the todo list dense and gives every actionable row an order context", async () => {
    const [contracts, todos, page] = await Promise.all([
      readFile("packages/contracts/src/todos.ts", "utf8"),
      readFile("apps/api/src/todos/service.ts", "utf8"),
      readFile("apps/web/src/my-todos-page.tsx", "utf8"),
    ]);
    expect(contracts).toContain("TodoOrderContextSchema");
    expect(todos).toContain("orderContext:");
    expect(todos).toContain("LEFT JOIN rework_orders orders");
    expect(page).toContain("my-todo-index");
    expect(page).toContain("订单号：{order?.orderNo");
    expect(page).toContain("节点停留");
    expect(page).toContain("相关金额");
  });

  it("groups the order flow into collapsible stages and renders one current node workspace", async () => {
    const [detail, task] = await Promise.all([
      readFile("apps/web/src/rework-detail-page.tsx", "utf8"),
      readFile("apps/web/src/responsibility-task-page.tsx", "utf8"),
    ]);
    expect(detail).toContain("rework-workflow__stage");
    expect(detail).toContain("<details");
    expect(detail).toContain('"01", "发起返工"');
    expect(detail).toContain('"09", "订单归档"');
    expect(detail).toContain("待判定后生成后续责任结算路径");
    expect(detail).toContain("selected.state !== \"current\"");
    expect(detail).toContain("<ProcessConfigurationForm reworkOrderId={detail.reworkOrderId}");
    expect(detail).toContain("<WorkReportingForm reworkOrderId={detail.reworkOrderId}");
    expect(task).toContain("<ReworkDetailPage");
    expect(task).toContain("returnToTodos");
  });
});
