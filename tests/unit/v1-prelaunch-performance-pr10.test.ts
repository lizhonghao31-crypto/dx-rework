import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const read = (path: string) => readFile(path, "utf8");

describe("1.0 prelaunch PR-10 perceived performance", () => {
  it("reuses the verified in-page session instead of refetching auth/me", async () => {
    const [auth, shell, reworkQuery, orderBoard] = await Promise.all([
      read("apps/web/src/auth.tsx"),
      read("apps/web/src/components.tsx"),
      read("apps/web/src/reporting/rework-query-page.tsx"),
      read("apps/web/src/order-board-page.tsx"),
    ]);

    expect(auth).toContain("export const verifySession");
    expect(shell).toContain("verifySession()");
    expect(reworkQuery).toContain("verifySession()");
    expect(orderBoard).toContain("verifySession()");
    expect(shell).not.toContain('apiUrl("auth/me")');
    expect(reworkQuery).not.toContain('apiUrl("auth/me")');
    expect(orderBoard).not.toContain('apiUrl("auth/me")');
  });

  it("loads each page immediately and debounces only typed search text", async () => {
    const [hook, reworkQuery, orderBoard, workflowQueue, wages] = await Promise.all([
      read("apps/web/src/use-debounced-value.ts"),
      read("apps/web/src/reporting/rework-query-page.tsx"),
      read("apps/web/src/order-board-page.tsx"),
      read("apps/web/src/reporting/workflow-queue-page.tsx"),
      read("apps/web/src/wages/wage-period-list.tsx"),
    ]);

    expect(hook).toContain("useState(value)");
    for (const page of [reworkQuery, orderBoard, workflowQueue, wages]) {
      expect(page).toContain("useDebouncedValue");
      expect(page).not.toContain("window.setTimeout");
    }
  });

  it("keeps ready business data visible while filters refresh", async () => {
    const [reworkQuery, orderBoard, workflowQueue, wages] = await Promise.all([
      read("apps/web/src/reporting/rework-query-page.tsx"),
      read("apps/web/src/order-board-page.tsx"),
      read("apps/web/src/reporting/workflow-queue-page.tsx"),
      read("apps/web/src/wages/wage-period-list.tsx"),
    ]);

    expect(reworkQuery).toContain('current.kind === "ready" ? current : { kind: "loading" }');
    expect(workflowQueue).toContain('current.kind === "ready" ? current : { kind: "loading" }');
    expect(wages).toContain('current.kind === "ready" ? current : { kind: "loading" }');
    expect(orderBoard).not.toContain("setData(null)");
  });
});
