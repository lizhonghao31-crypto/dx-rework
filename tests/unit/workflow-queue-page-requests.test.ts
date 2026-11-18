// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ManagementReworkQueueQuerySchema } from "@dx-rework/contracts/reporting";
import { WorkflowQueuePage } from "../../apps/web/src/reporting/workflow-queue-page.js";

vi.mock("../../apps/web/src/components.js", () => ({
  Header: () => null,
  Shell: ({ children }: { children: unknown }) => children,
}));

afterEach(() => vi.unstubAllGlobals());

describe("workflow queue page request scope", () => {
  it("loads one authorized page with counts, reuses the fallback, and reads only the selected page after navigation", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const denied = "pending_process_configuration", first = "pending_ie_review", second = "in_progress";
    const statuses = [denied, first, second] as const;
    window.history.replaceState({}, "", `?queue=${denied}`);
    const requests: { status: string; page: number }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const parsed = new URL(url, window.location.href);
      expect(parsed.pathname).toBe("/api/management/rework-workflow-queue");
      const filters = ManagementReworkQueueQuerySchema.parse(Object.fromEntries(parsed.searchParams));
      expect(filters.statuses).toEqual(statuses);
      requests.push({ status: filters.status, page: filters.page });
      const selected = filters.status === denied ? first : filters.status;
      const totalCount = selected === first ? 16 : 2;
      return new Response(JSON.stringify({
        selected,
        page: { asOf: "2026-11-18T10:00:00.000Z", items: [], page: filters.page, pageSize: filters.limit,
          totalCount, totalPages: Math.ceil(totalCount / filters.limit), canViewReports: false },
        statuses: [{ status: first, totalCount: 16 }, { status: second, totalCount: 2 }],
      }), { headers: { "content-type": "application/json" } });
    }));
    const shell = document.createElement("div");
    document.body.append(shell);
    const root = createRoot(shell);
    const button = (name: string) => [...shell.querySelectorAll("button")].find(item => item.textContent?.trim() === name)!;
    const render = () => root.render(createElement(WorkflowQueuePage, { active: "rework", title: "返工队列", statuses: [...statuses] }));
    try {
      await act(async () => render());
      expect(requests).toEqual([{ status: denied, page: 1 }]);
      expect(shell.textContent).not.toContain("待配置工序");
      expect(shell.textContent).toContain("N03 · 待 IE 审核 · 16 单");
      await act(async () => render());
      expect(requests).toHaveLength(1);
      await act(async () => button("2").click());
      await act(async () => button("N04 · 返工执行报数 · 2 单").click());
      await act(async () => button("立即刷新").click());
      expect(requests).toEqual([{ status: denied, page: 1 }, { status: first, page: 2 },
        { status: second, page: 1 }, { status: second, page: 1 }]);
      expect(window.location.search).toContain(`queue=${second}`);
    } finally {
      await act(async () => root.unmount());
      shell.remove();
    }
  });
});
