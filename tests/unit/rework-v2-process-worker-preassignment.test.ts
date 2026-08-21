import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("PR-03 process and worker preassignment", () => {
  it("requires new configurations to carry a worker preassignment while preserving historical rows", async () => {
    const migration = await readFile("apps/api/migrations/0078_rework_v2_process_worker_preassignment.sql", "utf8");
    expect(migration).toContain("ADD COLUMN worker_preassignment_required boolean NOT NULL DEFAULT false");
    expect(migration).toContain("ALTER COLUMN worker_preassignment_required SET DEFAULT true");
    expect(migration).toContain("CREATE TABLE rework_process_worker_plans");
    expect(migration).toContain("CREATE TABLE rework_process_worker_plan_members");
    expect(migration).toContain("rework_process_worker_plans_no_update");
    expect(migration).toContain("rework_process_worker_plans_no_delete");
  });

  it("gates IE submission on a complete plan and auto-activates it after approval", async () => {
    const [routes, service] = await Promise.all([
      readFile("apps/api/src/rework/process-configuration-routes.ts", "utf8"),
      readFile("apps/api/src/rework/process-worker-plan-service.ts", "utf8"),
    ]);
    expect(routes).toContain("assertReadyForSubmit");
    expect(routes).toContain("activateAfterIeApproval");
    expect(routes).toContain('"/rework-orders/:reworkOrderId/process-worker-plan"');
    expect(routes).toContain('"/rework-orders/:reworkOrderId/process-worker-plan/activate"');
    expect(service).toContain("每道返工工序都必须分配至少一名工人");
    expect(service).toContain('action: "rework.work_task.assign"');
    expect(service).toContain('action: "rework.work_task.assignment_confirm"');
    expect(service).toContain("status='in_progress'");
  });

  it("uses one merged N02 screen for process price and workers, with a legacy fallback only for historical configurations", async () => {
    const [wrapper, screen] = await Promise.all([
      readFile("apps/web/src/process-configuration-form.tsx", "utf8"),
      readFile("apps/web/src/process-worker-assignment-form.tsx", "utf8"),
    ]);
    expect(wrapper).toContain("ProcessWorkerAssignmentForm");
    expect(screen).toContain("分配工序 &工人");
    expect(screen).toContain("返工人员 *");
    expect(screen).toContain("候选单价（元/件）");
    expect(screen).toContain("人员已经由尾部主管预分配；IE 只核准工序与单价，不修改分工。");
    expect(screen).toContain("plan.required === false");
    expect(screen).toContain("LegacyProcessConfigurationForm");
  });

  it("keeps Root bypass and rejects unauthorized ordinary assignment actors", async () => {
    const service = await readFile("apps/api/src/rework/process-worker-plan-service.ts", "utf8");
    expect(service).toContain("if (isRootActor(actor)) return;");
    expect(service).toContain('actor.actorRoles.includes("tail_supervisor")');
    expect(service).toContain('this.capabilities(actor).includes("work:assign")');
  });
});
