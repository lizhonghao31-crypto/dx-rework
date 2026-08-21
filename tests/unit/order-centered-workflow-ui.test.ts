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
    expect(page).toContain("const orderSummary");
    expect(page).toContain("订单号：");
    expect(page).toContain("节点停留");
    expect(page).toContain("相关金额");
  });

  it("groups the order flow into collapsible stages and renders one current node workspace", async () => {
    const [detail, styles, task] = await Promise.all([
      readFile("apps/web/src/rework-detail-page.tsx", "utf8"),
      readFile("apps/web/src/rework-detail.css", "utf8"),
      readFile("apps/web/src/responsibility-task-page.tsx", "utf8"),
    ]);
    expect(detail).toContain("rework-workflow__stage");
    expect(detail).toContain("<details");
    expect(detail).toContain("const [collapsedStages, setCollapsedStages]");
    expect(detail).toContain('open={isOpen}');
    expect(detail).toContain('{isOpen ? "−" : "+"}');
    expect(detail).toContain('"01", "发起返工"');
    expect(detail).toContain('"08", "返工业务完成"');
    expect(detail).toContain("N06 选择每道工序的主责任方后提交老板签字；供应商计划扣款暂不生成。");
    expect(detail).toContain('selected.state !== "future"');
    expect(detail).toContain("return renderNodePreview()");
    expect(detail).toContain("<ProcessConfigurationForm reworkOrderId={detail.reworkOrderId}");
    expect(detail).toContain("<WorkReportingForm");
    expect(detail).toContain("taskMode={selected.key}");
    expect(detail).not.toContain('action: "返回全部订单"');
    expect(detail.match(/badge=\{meta\.label\}/g)).toHaveLength(1);
    expect(styles).toMatch(/\.rework-workflow__node\.is-completed \{[\s\S]*?background: #edf1f4;/);
    expect(styles).toMatch(/\.rework-workflow__node\.is-current \{[\s\S]*?background: var\(--dx-v2-color-primary\);/);
    expect(styles).toMatch(/\.rework-workflow__node\.is-future \{[\s\S]*?background: var\(--dx-v2-color-control\);/);
    expect(styles).toContain("color: rgb(255 255 255 / 80%);");
    expect(styles).not.toContain(".rework-workflow__node.is-selected");
    expect(detail).not.toContain('" is-selected"');
    expect(task).toContain("<ReworkDetailPage");
    expect(task).toContain("returnToTodos");
  });

  it("treats the terminal completed status as business completion while later settlement remains independent", async () => {
    const detail = await readFile("apps/web/src/rework-detail-page.tsx", "utf8");
    expect(detail).toContain('if (detail.status === "completed")');
    expect(detail).toContain('node("settlement_followup", "08", "返工业务完成"');
  });
});
