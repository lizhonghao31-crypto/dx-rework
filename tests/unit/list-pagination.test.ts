import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import {
  cursorPageWindow,
  LIST_PAGE_SIZE,
  listPageWindow,
} from "../../apps/web/src/list-pagination.js";

const read = (path: string) => readFile(path, "utf8");

describe("shared list pagination", () => {
  it("matches the My Todos five-page window and 15-row page size", () => {
    expect(LIST_PAGE_SIZE).toBe(15);
    expect(listPageWindow(1, 30)).toEqual([1, 2, 3, 4, 5]);
    expect(listPageWindow(8, 30)).toEqual([6, 7, 8, 9, 10]);
    expect(listPageWindow(30, 30)).toEqual([26, 27, 28, 29, 30]);
  });

  it("turns cursor navigation into reachable numeric page buttons", () => {
    expect(cursorPageWindow(1, false, true)).toEqual([1, 2]);
    expect(cursorPageWindow(2, true, true)).toEqual([1, 2, 3]);
    expect(cursorPageWindow(3, true, false)).toEqual([2, 3]);
  });

  it("is used by every independent business list route", async () => {
    const pages = [
      "apps/web/src/order-board-page.tsx",
      "apps/web/src/reporting/rework-query-page.tsx",
      "apps/web/src/reporting/workflow-queue-page.tsx",
      "apps/web/src/sourcing-workspace-page.tsx",
      "apps/web/src/master-data-page.tsx",
      "apps/web/src/admin-console-page.tsx",
      "apps/web/src/employee-access-page.tsx",
      "apps/web/src/workforce-master-data-page.tsx",
      "apps/web/src/frontline-task-page.tsx",
      "apps/web/src/responsibility-queue-page.tsx",
      "apps/web/src/own-factory-approval-queue-page.tsx",
      "apps/web/src/external-responsibility-queue-page.tsx",
      "apps/web/src/wages/wage-period-list.tsx",
      "apps/web/src/reporting/report-center-page.tsx",
    ];
    for (const path of pages) {
      expect(await read(path), path).toMatch(/ListPagination/);
    }
  });

  it("uses My Todos as the only pagination view and does not inherit sidebar layout", async () => {
    const [source, shellStyles, workbenchStyles, myTodosStyles] = await Promise.all([
      read("apps/web/src/list-pagination.tsx"),
      read("apps/web/src/styles.css"),
      read("apps/web/src/rework-workbench.css"),
      read("apps/web/src/my-todos.css"),
    ]);

    expect(source).toContain('import "./my-todos.css"');
    expect(source).toContain('<nav className="my-todos-pagination"');
    expect(source).toContain('className="my-todos-pagination__ellipsis"');
    expect(source.match(/<PaginationNav/g)).toHaveLength(2);
    expect(source).not.toContain('"./list-pagination.css"');
    expect(source).not.toMatch(/[‹›]/);
    expect(shellStyles).toContain(".app-shell > aside > nav { display: grid;");
    expect(shellStyles).not.toMatch(/\.app-shell nav\s*\{/);
    expect(workbenchStyles).toContain("body .app-shell > aside > nav {");
    expect(workbenchStyles).not.toMatch(/body \.app-shell nav\s*\{/);
    expect(myTodosStyles).toContain(".my-todos-pagination {");
    expect(myTodosStyles).toContain("width: 34px");
    expect(myTodosStyles).toContain("width: 32px");
  });

  it("does not retain the oversized legacy pager markup", async () => {
    const sources = await Promise.all([
      read("apps/web/src/order-board-page.tsx"),
      read("apps/web/src/reporting/rework-query-page.tsx"),
      read("apps/web/src/sourcing-workspace-page.tsx"),
      read("apps/web/src/master-data-page.tsx"),
      read("apps/web/src/admin-console-page.tsx"),
    ]);
    const combined = sources.join("\n");
    expect(combined).not.toMatch(/order-board-pagination|reporting-pagination|sourcing-pagination|master-data-process-pager|admin-pager/);
  });
});
