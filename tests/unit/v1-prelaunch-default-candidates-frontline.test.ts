import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { frontlineEntries } from "../../apps/web/src/frontline-landing-page.js";
import { landingTarget } from "../../apps/web/src/landing-target.js";

const user = (role: string | readonly string[], capabilities: readonly string[]) => ({
  displayName: "测试用户",
  businessRoles: typeof role === "string" ? [role] : [...role],
  capabilities,
});

describe("v1 prelaunch default candidates and frontline entry", () => {
  it("routes each single frontline role directly and keeps the chooser for multiple jobs", () => {
    expect(landingTarget(user("warehouse_receiver", ["receiving:create", "todo:view"]))).toBe("ui/receiving");
    expect(landingTarget(user("worker", ["work:report", "todo:view"]))).toBe("ui/frontline/tasks?kind=worker");
    expect(landingTarget(user("tail_inspector", ["tail_inspection:report", "todo:view"]))).toBe("ui/frontline/tasks?kind=tail_inspection");
    expect(landingTarget(user(
      ["warehouse_receiver", "tail_inspector"],
      ["receiving:create", "tail_inspection:report", "todo:view"],
    ))).toBe("ui/frontline");
  });

  it("shows each frontline role its own task entry and shared todos", () => {
    expect(frontlineEntries(user("warehouse_receiver", ["receiving:create", "todo:view"])).map((entry) => entry.label)).toEqual(["仓库收货", "我的待办"]);
    expect(frontlineEntries(user("worker", ["work:report", "todo:view"])).map((entry) => entry.label)).toEqual(["本人返工任务", "我的待办"]);
    const tailEntries = frontlineEntries(user("tail_inspector", ["tail_inspection:report", "todo:view"]));
    expect(tailEntries.map((entry) => entry.label)).toEqual(["本人尾查任务", "我的待办"]);
    expect(frontlineEntries(user("worker", ["work:report"]))[0]?.href).toContain("ui/frontline/tasks?kind=worker");
    expect(tailEntries[0]?.href).toContain("ui/frontline/tasks?kind=tail_inspection");
  });

  it("keeps N02 edits order-local until the dedicated default-roster save", async () => {
    const [masterData, form, app, detail, reporting, assignmentSheetStyles] = await Promise.all([
      readFile(new URL("../../apps/web/src/master-data-page.tsx", import.meta.url), "utf8"),
      readFile(new URL("../../apps/web/src/process-worker-assignment-form.tsx", import.meta.url), "utf8"),
      readFile(new URL("../../apps/web/src/App.tsx", import.meta.url), "utf8"),
      readFile(new URL("../../apps/web/src/rework-detail-page.tsx", import.meta.url), "utf8"),
      readFile(new URL("../../apps/api/src/reporting/management-reporting-service.ts", import.meta.url), "utf8"),
      readFile(new URL("../../apps/web/src/process-worker-assignment-mobile-sheet.css", import.meta.url), "utf8"),
    ]);

    expect(masterData).toContain("默认候选人");
    expect(masterData).toContain("新订单选择该工序时自动带入，可在订单内调整。");
    expect(form).toContain("选择本单工人");
    expect(form).toContain("保存为默认名单");
    expect(form).toContain("saveDefaultWorkers(index)");
    expect(form).toContain("本单人员已调整");
    expect(form).toContain("只有点击“保存为默认名单”才会更新以后订单的默认工人");
    expect(form).not.toContain('placeholder="搜索正式工或临时工" disabled={busy} onChange={(event) => setWorkerSearches');
    expect(assignmentSheetStyles).toContain("@media(min-width:641px)");
    expect(assignmentSheetStyles).toContain(".process-worker-mobile-sheet-backdrop{position:fixed;inset:0;z-index:1080;display:grid");
    expect(app).toContain('path === "/ui/frontline"');
    expect(app).toContain('{ requiredRole: "tail_inspector", requiredCapability: "tail_inspection:report" }');
    expect(reporting).toContain('"work:report_for_worker", "tail_inspection:report"');
    expect(reporting).toContain('actor.actorRoles.includes("tail_inspector")');
    expect(reporting).toContain("workTaskActorUserId: actor.actorId");
    expect(detail).not.toContain('node("tail_inspection"');
  });
});
