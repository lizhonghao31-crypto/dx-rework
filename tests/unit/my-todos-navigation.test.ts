import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("my todos first-entry navigation", () => {
  it("lands todo-capable users on an actionable personal queue", async () => {
    const [app, landing, components, page] = await Promise.all([
      readFile("apps/web/src/App.tsx", "utf8"),
      readFile("apps/web/src/landing-target.ts", "utf8"),
      readFile("apps/web/src/components.tsx", "utf8"),
      readFile("apps/web/src/my-todos-page.tsx", "utf8"),
    ]);

    expect(app).toContain('path === "/ui/my-tasks"');
    expect(app).toContain('requiredCapability="todo:view"');
    expect(landing).toContain('has(user, "todo:view")');
    expect(landing).toContain('return "ui/my-tasks"');
    expect(components).toContain('name: "我的待办"');
    expect(page).toContain('apiUrl("todos/mine")');
    expect(page).toContain("这里只显示现在轮到你处理的事项");
    expect(page).toContain("开始处理");
    expect(page).toContain("您当前的任务已全部完成，谢谢");
  });
});
