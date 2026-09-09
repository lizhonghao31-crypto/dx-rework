import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFile(path, "utf8");

describe("PR03-A review closure", () => {
  it("keeps production role mutation service and database guards Root-only", async () => {
    const [server, workerAwareAccess, migration] = await Promise.all([
      read("apps/api/src/server.ts"),
      read("apps/api/src/access/worker-aware-access-service.ts"),
      read("apps/api/migrations/0166_permission_role_field_closure.sql"),
    ]);

    expect(server).toContain("new WorkerAwareAccessMasterDataService");
    expect(workerAwareAccess).toContain('throw new ApplicationError("FORBIDDEN", "人员与业务角色仅允许 Root 维护", 403)');
    expect(workerAwareAccess.match(/人员与业务角色仅允许 Root 维护/g)).toHaveLength(2);
    expect(migration).toContain("CREATE OR REPLACE FUNCTION access_role_manager_roles");
    expect(migration).toContain("IF NOT access_is_root_actor(requested_actor_id) THEN");
    expect(migration).toContain("business roles can only be maintained by root");
  });

  it("enforces employee administration at route, service and database-backed state boundaries", async () => {
    const [routes, service, migration] = await Promise.all([
      read("apps/api/src/access/employee-access-routes.ts"),
      read("apps/api/src/access/employee-access-service.ts"),
      read("apps/api/migrations/0166_permission_role_field_closure.sql"),
    ]);

    expect(routes).toContain("dependencies.service.listDirectory(actor)");
    expect(service).toContain("SELECT access_is_root_actor($1) allowed");
    expect(service).toContain("人员与权限管理仅允许 Root");
    expect(service).toContain("dx_rework.employee_access_actor_id");
    expect(service).toContain("actor\n        ? this.database.query<RoleHistoryRow>");
    expect(migration).toContain("CREATE OR REPLACE FUNCTION guard_employee_access_state_root");
    expect(migration).toContain("employee access state can only be maintained by root");
    expect(migration).toContain("app_users_employee_access_root_guard");
  });

  it("attributes replacement worker grants to the migration actor while preserving source provenance", async () => {
    const migration = await read("apps/api/migrations/0166_permission_role_field_closure.sql");

    expect(migration).toContain("replacement.migration_actor_id");
    expect(migration).toContain("'sourceGrantedBy',replacement.source_granted_by");
    expect(migration).toContain("'migrationActorId',replacement.migration_actor_id");
    expect(migration).toContain("ARRAY['root_superuser','migration_0166']");
    expect(migration).not.toContain("replacement.assignment_id,replacement.user_id,'worker',replacement.granted_by");
  });

  it("accepts the retired tail role only for historical reads and blocks it at every new-report database mutation", async () => {
    const [service, migration] = await Promise.all([
      read("apps/api/src/rework/tail-inspection-service.ts"),
      read("apps/api/migrations/0166_permission_role_field_closure.sql"),
    ]);
    const reporterGuard = service.split("private ensureReporter")[1]?.split("private ensureReviewer")[0] ?? "";
    const readGuard = service.split("private ensureRead")[1]?.split("private async order")[0] ?? "";

    expect(reporterGuard).toContain('actor.actorRoles.includes("worker")');
    expect(reporterGuard).not.toContain('actor.actorRoles.includes("tail_inspector")');
    expect(readGuard).toContain('actor.actorRoles.includes("tail_inspector")');
    expect(migration).toContain("CREATE OR REPLACE FUNCTION guard_rework_work_report_insert");
    expect(migration).toContain("assignment.role_code='worker'");
    expect(migration).toContain("access_is_root_actor(event.actor_id)");
    expect(migration).toContain("work report requires current execution-kind authorization");
  });
});
