import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { Pagination } from "@dx-rework/ui/production";

import {
  LIST_PAGE_SIZE,
  ListPagination,
  listPageWindow,
} from "../../apps/web/src/list-pagination.js";

const read = (path: string) => readFile(path, "utf8");

describe("shared list pagination", () => {
  it("matches the My Todos five-page window and 15-row page size", () => {
    expect(LIST_PAGE_SIZE).toBe(15);
    expect(listPageWindow(1, 30)).toEqual([1, 2, 3, 4, 5]);
    expect(listPageWindow(20, 30)).toEqual([18, 19, 20, 21, 22]);
    expect(listPageWindow(30, 30)).toEqual([26, 27, 28, 29, 30]);
  });

  it("can recover an out-of-range page without treating the remaining records as empty", () => {
    const noop = () => {};
    const list = new JSDOM(renderToStaticMarkup(createElement(ListPagination, {
      page: 2, totalPages: 1, total: 15, ariaLabel: "测试分页", onPageChange: noop,
    }))).window.document;
    const production = new JSDOM(renderToStaticMarkup(createElement(Pagination, {
      page: 2, pageSize: 15, total: 15, onPage: noop,
    }))).window.document;
    for (const view of [list, production]) {
      const buttons = Array.from(view.querySelectorAll("button"));
      expect(view.querySelector("nav.dx-pagination-frame")?.textContent).toContain("共 15 条 · 第 2 页");
      expect(buttons.find(button => button.textContent === "上一页")?.disabled).toBe(false);
      expect(buttons.find(button => button.textContent === "下一页")?.disabled).toBe(true);
    }
    expect(list.querySelector('[aria-current="page"]')).toBeNull();
    expect(Array.from(list.querySelectorAll("button")).find(button => button.textContent === "1")?.disabled).toBe(false);
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
    const [source, shellStyles, workbenchStyles, myTodosStyles, sharedStyles] = await Promise.all([
      read("apps/web/src/list-pagination.tsx"),
      read("apps/web/src/styles.css"),
      read("apps/web/src/rework-workbench.css"),
      read("apps/web/src/my-todos.css"),
      read("packages/ui/src/components.css"),
    ]);

    expect(source).toContain('import "./my-todos.css"');
    expect(source).toContain('className="my-todos-pagination dx-pagination-frame');
    expect(source).toContain('className="my-todos-pagination__ellipsis"');
    expect(source.match(/<PaginationNav/g)).toHaveLength(1);
    expect(source).toContain('page: 1');
    expect(source).toContain('page: pageCount');
    expect(source).not.toContain("CursorListPagination");
    expect(source).not.toContain('"./list-pagination.css"');
    expect(source).not.toMatch(/[‹›]/);
    expect(shellStyles).toContain(".app-shell > aside > nav { display: grid;");
    expect(shellStyles).not.toMatch(/\.app-shell nav\s*\{/);
    expect(workbenchStyles).toContain("body .app-shell > aside > nav {");
    expect(workbenchStyles).not.toMatch(/body \.app-shell nav\s*\{/);
    expect(myTodosStyles).toContain(".my-todos-pagination {");
    expect(myTodosStyles).not.toMatch(/width: (?:32|34)px/);
    expect(sharedStyles).toMatch(/\.dx-pagination-frame[^}]*justify-content: center/);
    expect(sharedStyles).toMatch(/\.dx-pagination-frame--native[^}]*white-space: nowrap/);
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
