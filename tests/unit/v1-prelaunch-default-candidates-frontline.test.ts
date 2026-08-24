import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { frontlineEntries } from "../../apps/web/src/frontline-landing-page.js";
import { landingTarget } from "../../apps/web/src/landing-target.js";

const user = (role: string, capabilities: readonly string[]) => ({
  displayName: "测试用户",
  businessRoles: [role],
  capabilities,
});

describe("v1 prelaunch default candidates and frontline entry", () => {
  it("routes warehouse, worker and tail-inspector roles to the frontline landing", () => {
    expect(landingTarget(user("warehouse_receiver", ["receiving:create", "todo:view"]))).toBe("ui/frontline");
    expect(landingTarget(user("worker", ["work:report", "todo:view"]))).toBe("ui/frontline");
    expect(landingTarget(user("tail_inspector", ["tail_inspection:report", "todo:view"]))).toBe("ui/frontline");
  });

  it("shows each frontline role its own task entry and shared todos", () => {
    expect(frontlineEntries(user("warehouse_receiver", ["receiving:create", "todo:view"])).map((entry) => entry.label)).toEqual(["仓库收货", "我的待办"]);
    expect(frontlineEntries(user("worker", ["work:report", "todo:view"])).map((entry) => entry.label)).toEqual(["本人返工任务", "我的待办"]);
    const tailEntries = frontlineEntries(user("tail_inspector", ["tail_inspection:report", "todo:view"]));
    expect(tailEntries.map((entry) => entry.label)).toEqual(["本人尾查任务", "我的待办"]);
    expect(tailEntries[0]?.href).toContain("ui/work-reporting?queue=in_progress");
  });

  it("keeps N02 order-local changes separate from the global default roster", async () => {
    const [masterData, form, app, detail, reporting] = await Promise.all([
      readFile(new URL("../../apps/web/src/master-data-page.tsx", import.meta.url), "utf8"),
      readFile(new URL("../../apps/web/src/process-worker-assignment-form.tsx", import.meta.url), "utf8"),
      readFile(new URL("../../apps/web/src/App.tsx", import.meta.url), "utf8"),
      readFile(new URL("../../apps/web/src/rework-detail-page.tsx", import.meta.url), "utf8"),
      readFile(new URL("../../apps/api/src/reporting/management-reporting-service.ts", import.meta.url), "utf8"),
    ]);

    expect(masterData).toContain("默认候选人");
    expect(masterData).toContain("新订单选择该工序时自动带入，可在订单内调整。");
    expect(form).toContain("已自动带入 {item.defaultCandidateCount} 名默认候选人");
    expect(form).not.toContain("replaceProcessDefaultWorkers(");
    expect(app).toContain('path === "/ui/frontline"');
    expect(app).toContain('{ requiredRole: "tail_inspector", requiredCapability: "tail_inspection:report" }');
    expect(reporting).toContain('"work:report_for_worker", "tail_inspection:report"');
    expect(reporting).toContain('actor.actorRoles.includes("tail_inspector")');
    expect(reporting).toContain("workTaskActorUserId: actor.actorId");
    expect(detail).not.toContain('node("tail_inspection"');
  });
});
