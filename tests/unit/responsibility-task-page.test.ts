import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("responsibility task page", () => {
  it("opens one responsibility task and follows durable todo completion", async () => {
    const [app, list, task, external, detail] = await Promise.all([
      readFile("apps/web/src/App.tsx", "utf8"),
      readFile("apps/web/src/my-todos-page.tsx", "utf8"),
      readFile("apps/web/src/responsibility-task-page.tsx", "utf8"),
      readFile("apps/web/src/external-responsibility-panel.tsx", "utf8"),
      readFile("apps/web/src/rework-detail-page.tsx", "utf8"),
    ]);

    expect(app).toContain('path.startsWith("/ui/my-tasks/")');
    expect(list).toContain('pageUrl(`ui/my-tasks/${todo.todoId}`)');
    expect(list).toContain('todo.todoType !== "information"');
    expect(task).toContain('item.todoId === todoId');
    expect(task).toContain('todo.status === "completed"');
    expect(task).toContain("该任务已不再分配给你");
    expect(task).toContain("您在本订单内的任务已全部完成，谢谢");
    expect(task).toContain("<ReworkDetailPage");
    expect(task).toContain("returnToTodos");
    expect(task).not.toContain("window.location.replace");
    expect(external).toContain("focusCaseId");
    expect(external).toContain('caseItem.caseId === focusCaseId');
    expect(detail).toContain('node.state === "current" || node.state === "followup"');
    expect(detail).toContain("focusedNode === activeNode");
  });
});
