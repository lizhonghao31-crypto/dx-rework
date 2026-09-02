import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { LIST_PAGE_SIZE, listPageWindow } from "../../apps/web/src/list-pagination.js";

const read = (path: string) => readFile(path, "utf8");

describe("shared list pagination", () => {
  it("matches the My Todos five-page window and 15-row page size", () => {
    expect(LIST_PAGE_SIZE).toBe(15);
    expect(listPageWindow(1, 30)).toEqual([1, 2, 3, 4, 5]);
    expect(listPageWindow(8, 30)).toEqual([6, 7, 8, 9, 10]);
    expect(listPageWindow(30, 30)).toEqual([26, 27, 28, 29, 30]);
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
