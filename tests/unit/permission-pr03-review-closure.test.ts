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

  it("attributes replacement worker grants to the migration actor while preserving source provenance", async () => {
    const migration = await read("apps/api/migrations/0166_permission_role_field_closure.sql");

    expect(migration).toContain("replacement.migration_actor_id");
    expect(migration).toContain("'sourceGrantedBy',replacement.source_granted_by");
    expect(migration).toContain("'migrationActorId',replacement.migration_actor_id");
    expect(migration).toContain("ARRAY['root_superuser','migration_0166']");
    expect(migration).not.toContain("replacement.assignment_id,replacement.user_id,'worker',replacement.granted_by");
  });

  it("accepts the retired tail role only for historical reads, never for a new report submission", async () => {
    const service = await read("apps/api/src/rework/tail-inspection-service.ts");
    const reporterGuard = service.split("private ensureReporter")[1]?.split("private ensureReviewer")[0] ?? "";
    const readGuard = service.split("private ensureRead")[1]?.split("private async order")[0] ?? "";

    expect(reporterGuard).toContain('actor.actorRoles.includes("worker")');
    expect(reporterGuard).not.toContain('actor.actorRoles.includes("tail_inspector")');
    expect(readGuard).toContain('actor.actorRoles.includes("tail_inspector")');
  });
});
