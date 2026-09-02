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
    expect(page).toContain("my-todo-row");
    expect(page).toContain("my-todos-modules");
    expect(page).toContain('{ id: "rework", label: "订单返工" }');
    expect(page).toContain('{ id: "sourcing", label: "外发定价&选厂" }');
    expect(page).not.toContain('{ id: "wages", label: "返工工资" }');
    expect(page).toContain("{moduleCounts[module.id]}件");
    expect(page).toContain("useDebouncedValue(searchQuery.trim(), 250)");
    expect(page).toContain("maxLength={100}");
    expect(page).not.toContain('type="submit"');
    expect(page).toContain("todos.map");
    expect(page).toContain("my-todos-pagination");
    expect(page).toContain("visiblePages.map");
    expect(page).toContain("Math.max(totalPages, 1)");
    expect(page).not.toContain("{totalPages > 1 && <nav");
    expect(page).not.toContain('aria-label="前五页"');
    expect(page).not.toContain('aria-label="后五页"');
    expect(page).toContain("todoPageWindow(page, renderedTotalPages)");
    expect(page).toContain('className="my-todos-pagination__ellipsis"');
    expect(page).toContain("my-todo-index");
    expect(page).toContain("节点停留");
    expect(page).toContain("您当前的任务已全部完成。有新的事项轮到你处理时，会出现在这里。");
    expect(page).not.toContain('state.kind === "ready" && totalActionable > 0 && <nav');
    expect(page).not.toContain('state.kind === "ready" && totalActionable > 0 && <Surface className="my-todos-workspace"');
    expect(page).not.toContain('state.kind === "ready" && <nav className="my-todos-modules"');
    expect(page).toContain('state.kind === "ready" && <Surface className="my-todos-workspace"');
    expect(page).toContain('<div className="my-todos-toolbar">');
    expect(page).toContain('<div className="my-todos-modules" role="tablist"');
    expect(page).not.toContain('<nav className="my-todos-modules"');
    expect(page.indexOf('{ id: "sourcing", label: "外发定价&选厂" }')).toBeLessThan(
      page.indexOf('{ id: "rework", label: "订单返工" }'),
    );
    expect(page).not.toContain("<span>搜索待办</span>");
    expect(page).toContain('aria-label="搜索待办"');
    expect(page).toContain("todoModuleIdsForUser(session.user)");
    expect(page).toContain("visibleTodoModules.map");
  });

  it("keeps the mobile task list aligned to the product hierarchy without changing the action path", async () => {
    const [page, css] = await Promise.all([
      readFile("apps/web/src/my-todos-page.tsx", "utf8"),
      readFile("apps/web/src/my-todos.css", "utf8"),
    ]);

    expect(page).toContain('className="my-todos-page"');
    expect(page).toContain('className="page-heading my-todos-hero"');
    expect(page).toContain('className="my-todos-hero__title"');
    expect(page).toContain('apiUrl("todos/mine")');
    expect(page).toContain("taskHref(todo)");
    expect(page).toContain("my-todo-metrics");

    expect(css).toContain("@media (max-width: 800px)");
    expect(css).toContain(".my-todos-hero");
    expect(css).toContain(".my-todos-modules");
    expect(css).toContain("background: var(--dx-v2-color-control);");
    expect(css).toContain("justify-content: center;");
    expect(css).toContain("grid-template-columns: minmax(0, 1fr);");
    expect(css).toContain("repeat(auto-fit, minmax(min(140px, 100%), 1fr))");
    expect(css).toContain("width: 100%;");
    expect(css).toContain("margin-left: 0;");
    expect(css).toContain("background: var(--dx-v2-color-inset);");
    expect(css).toContain("overflow: visible;");
    expect(css).not.toContain("overflow-x: auto;");
    expect(css).toContain("background: transparent;");
    expect(css).toContain("background: var(--dx-v2-color-control);");
    expect(css).toContain(".my-todo-index {");
    expect(css).toContain("display: none;");
    expect(css).toContain(".my-todo-metrics span:nth-child(2)");
    expect(css).toContain("env(safe-area-inset-bottom, 0px)");
  });
});
