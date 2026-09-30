import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("authorization policy closure", () => {
  it("keeps Root centralized and owner/system-admin axes explicit", async () => {
    const [authority, root, migration, canonicalization] = await Promise.all([
      readFile("apps/api/src/access/business-authority.ts", "utf8"),
      readFile("apps/api/src/access/root-authority.ts", "utf8"),
      readFile("apps/api/migrations/0036_permission_authority_closure.sql", "utf8"),
      readFile("apps/api/migrations/0063_root_actor_role_snapshot_canonicalization.sql", "utf8"),
    ]);

    expect(authority).toContain('ROOT_ACTOR_ROLE = "root_superuser"');
    expect(authority).toContain('BUSINESS_READ_ALL_CAPABILITY = "business:read_all"');
    expect(root).toContain("owner_bootstrap_consumptions");
    expect(root).toContain("assertConfigurationConsistency");
    expect(migration).toContain("('owner_group','business:read_all')");
    expect(canonicalization).toContain("array_agg(role_code ORDER BY role_code)");
    expect(canonicalization).toContain("array_append(COALESCE(actor_roles,'{}'::text[]),'root_superuser')");
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
    expect(migration).toContain("CREATE UNIQUE INDEX user_role_assignments_singleton_direct_role_idx");
    expect(migration).toContain("WHERE revoked_at IS NULL");
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
    expect(projection).toContain("override async actionableForIndependentOwner(");
    expect(projection).toContain("if (this.suppress(args[1], error)) return;");
  });
});

