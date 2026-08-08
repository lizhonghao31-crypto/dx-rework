import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("authorization policy closure", () => {
  it("keeps Root centralized and owner/system-admin axes explicit", async () => {
    const [authority, root, migration] = await Promise.all([
      readFile("apps/api/src/access/business-authority.ts", "utf8"),
      readFile("apps/api/src/access/root-authority.ts", "utf8"),
      readFile("apps/api/migrations/0036_permission_authority_closure.sql", "utf8"),
    ]);

    expect(authority).toContain('ROOT_ACTOR_ROLE = "root_superuser"');
    expect(authority).toContain('BUSINESS_READ_ALL_CAPABILITY = "business:read_all"');
    expect(root).toContain("owner_bootstrap_consumptions");
    expect(root).toContain("assertConfigurationConsistency");
    expect(migration).toContain("('owner_group','business:read_all')");
    expect(migration).toContain("('owner_group','audit:read')");
    expect(migration).toContain("('owner_group','dashboard:site:read')");
    expect(migration).toContain("role_code='system_admin'");
    expect(migration).toContain("'dashboard:management:read'");
    expect(migration).toContain("'master_data:manage'");
    expect(migration).toContain("'wage:view'");
  });

  it("prevents direct-recipient roles from becoming ambiguously assigned", async () => {
    const migration = await readFile(
      "apps/api/migrations/0036_permission_authority_closure.sql",
      "utf8",
    );
    for (const role of [
      "tail_supervisor",
      "ie_reviewer",
      "production_management",
      "embroidery_washing_merchandiser",
      "factory_payables",
      "embroidery_washing_payables",
      "fabric_payables",
      "administrative_clerk",
      "wage_month_close_accountant",
    ]) {
      expect(migration).toContain(`'${role}'`);
    }
    expect(migration).toContain("guard_singleton_direct_role_assignment");
    expect(migration).toContain("guard_singleton_direct_role_reactivation");
  });

  it("uses the same Root authority in the major business HTTP boundaries", async () => {
    const paths = [
      "apps/api/src/rework/routes.ts",
      "apps/api/src/rework/process-configuration-routes.ts",
      "apps/api/src/rework/work-reporting-routes.ts",
      "apps/api/src/rework/whole-order-review-routes.ts",
      "apps/api/src/rework/responsibility-determination-routes.ts",
      "apps/api/src/rework/own-factory-approval-routes.ts",
      "apps/api/src/rework/external-responsibility-routes.ts",
      "apps/api/src/wages/wage-routes.ts",
    ];
    const sources = await Promise.all(paths.map((path) => readFile(path, "utf8")));
    for (const source of sources) {
      expect(source).toContain("RootAuthority");
    }
    expect(sources.slice(1).every((source) => source.includes("businessActor"))).toBe(true);
  });

  it("keeps Root UAT todo bypass narrow and ordinary routing strict", async () => {
    const projection = await readFile(
      "apps/api/src/todos/root-aware-projection-service.ts",
      "utf8",
    );
    expect(projection).toContain('actor.actorRoles.includes("root_superuser")');
    expect(projection).toContain("isAcceptanceRoutingConflict");
    expect(projection).toContain("throw error");
    expect(projection).not.toContain("actionableForIndependentOwner(");
  });
});
