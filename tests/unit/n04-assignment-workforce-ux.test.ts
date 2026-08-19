import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFile(path, "utf8");

describe("N04 assignment workforce UX", () => {
  it("separates formal and temporary workers and supports inline temporary-worker creation", async () => {
    const [web, routes, migration] = await Promise.all([
      read("apps/web/src/work-reporting-form.tsx"),
      read("apps/api/src/access/routes.ts"),
      read("apps/api/migrations/0071_n04_assignment_workforce_ux.sql"),
    ]);

    expect(web).toContain(">正式工<");
    expect(web).toContain(">临时工<");
    expect(web).toContain("+ 添加临时工");
    expect(web).toContain('person.personType === peopleType');
    expect(web).toContain('master-data/temporary-workers');
    expect(routes).toContain('actor(request, "temporary_worker:manage")');
    expect(routes).toContain('input.personType !== "temporary"');
    expect(migration).toContain("('tail_supervisor','temporary_worker:manage')");
    expect(migration).toContain("('owner_group','temporary_worker:manage')");
  });

  it("removes mistaken assignments only through the audited N04 correction path", async () => {
    const [web, routes, service, migration] = await Promise.all([
      read("apps/web/src/work-reporting-form.tsx"),
      read("apps/api/src/access/routes.ts"),
      read("apps/api/src/access/worker-aware-access-service.ts"),
      read("apps/api/migrations/0071_n04_assignment_workforce_ux.sql"),
    ]);

    expect(web).toContain('work-tasks/${removalTask.workTaskId}/remove');
    expect(web).toContain("确认移除");
    expect(routes).toContain('"/work-tasks/:workTaskId/remove"');
    expect(service).toContain('task.order_status !== "pending_task_assignment"');
    expect(service).toContain('action = "rework.work_task.remove"');
    expect(service).toContain("SET status='superseded'");
    expect(migration).toContain("'rework.work_task.remove'");
    expect(web).not.toContain("window.confirm");
  });
});
