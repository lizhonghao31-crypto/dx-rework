import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { formatTodoBadgeCount } from "../../apps/web/src/todo-new-indicator.js";

describe("todo navigation count badge", () => {
  it("shows exact counts through 99 and caps larger values", () => {
    expect(formatTodoBadgeCount(1)).toBe("1");
    expect(formatTodoBadgeCount(99)).toBe("99");
    expect(formatTodoBadgeCount(100)).toBe("99+");
  });

  it("uses the server count regardless of navigation clicks or active page", async () => {
    const source = await readFile("apps/web/src/components.tsx", "utf8");
    expect(source).toContain("setPendingTodoCount(indicator.pendingCount)");
    expect(source).toContain("<TodoCountBadge count={pendingTodoCount} />");
    expect(source).not.toContain("localStorage");
    expect(source).not.toContain("writeSeenTodoMarker");
    expect(source).not.toContain('active === "我的待办"');
    expect(source).not.toContain("onOpenTodos");
  });

  it("renders a compact icon-attached iOS-style badge without changing card height", async () => {
    const styles = await readFile("apps/web/src/shell-navigation.css", "utf8");
    expect(styles).toContain(".todo-count-badge");
    expect(styles).toContain("position: absolute");
    expect(styles).toContain("border-radius: 999px");
    expect(styles).toContain("min-width: 18px");
    expect(styles).toContain("left: calc(50% - 10px)");
    expect(styles).not.toContain("todo-new-indicator-pulse");
  });
});
