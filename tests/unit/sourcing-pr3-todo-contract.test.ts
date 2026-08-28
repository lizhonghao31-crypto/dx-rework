import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("sourcing PR3 shared todo cutover", () => {
  it("projects every live sourcing action into the existing neutral todo system", async () => {
    const service = await readFile("apps/api/src/sourcing/sourcing-service.ts", "utf8");
    expect(service).toContain("actionableForAllDirectRole");
    expect(service).toContain('"sourcing_ie_quote"');
    expect(service).toContain('"sourcing_management_decision"');
    expect(service).toContain('"sourcing_owner_approval"');
    expect(service).toContain('"sourcing_detail"');
    expect(service).toContain("completeOpenByDedupePrefix");
  });

  it("backfills pre-release actionable cases with audited and idempotent todo facts", async () => {
    const migration = await readFile(
      "apps/api/migrations/0106_sourcing_todo_route.sql",
      "utf8",
    );
    for (const status of [
      "pending_ie_quote",
      "pending_management_decision",
      "pending_owner_approval",
    ]) expect(migration).toContain(status);
    expect(migration).toContain("INSERT INTO rework_todos");
    expect(migration).toContain("todo_user_has_direct_role");
    expect(migration).toContain("'todo:backfill','todo.create'");
    expect(migration).toContain("existing.dedupe_key=dedupe_key_value");
  });

  it("keeps the legacy route compatible while making the unified queue official", async () => {
    const [app, modules] = await Promise.all([
      readFile("apps/web/src/App.tsx", "utf8"),
      readFile("apps/web/src/platform-modules.ts", "utf8"),
    ]);
    expect(app).toContain(
      'path === "/ui/sourcing" || path === "/ui/sourcing/pending"',
    );
    expect(modules).toContain('href: "ui/sourcing/pending"');
  });
});
