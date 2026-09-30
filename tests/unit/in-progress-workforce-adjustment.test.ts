import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const migrationUrl = new URL(
  "../../apps/api/migrations/0104_in_progress_workforce_adjustment.sql",
  import.meta.url,
);

describe("in-progress workforce adjustment migration", () => {
  it("grants the dedicated capability only to tail supervisors and owners", async () => {
    const sql = await readFile(migrationUrl, "utf8");
    expect(sql).toContain("('tail_supervisor','work:assignment_adjust')");
    expect(sql).toContain("('owner_group','work:assignment_adjust')");
    expect(sql).not.toContain("('production_management','work:assignment_adjust')");
    expect(sql).not.toContain("('quality_control','work:assignment_adjust')");
    expect(sql).not.toContain("('worker','work:assignment_adjust')");
    expect(sql).not.toContain("('order_merchandiser','work:assignment_adjust')");
  });

  it("guards task inserts, removals, and same-state order version writes with the new capability", async () => {
    const sql = await readFile(migrationUrl, "utf8");
    expect(sql).toContain("event.action='rework.work_task.active_add'");
    expect(sql).toContain("event.action='rework.work_task.active_remove'");
    expect(sql).toContain("event.authorization_capability='work:assignment_adjust'");
    expect(sql).toContain("alternative_action:='rework.work_task.active_add'");
    expect(sql).toContain("alternative_action_two:='rework.work_task.active_remove'");
  });

  it("keeps the manifest checksum aligned with the exact migration bytes", async () => {
    const [sql, manifestText] = await Promise.all([
      readFile(migrationUrl, "utf8"),
      readFile(new URL("../../apps/api/src/platform/migration-manifest.json", import.meta.url), "utf8"),
    ]);
    const manifest = JSON.parse(manifestText) as {
      migrations: Array<{ version: string; checksum: string }>;
    };
    const entry = manifest.migrations.find(
      (migration) => migration.version === "0104_in_progress_workforce_adjustment",
    );
    expect(entry?.checksum).toBe(createHash("sha256").update(sql).digest("hex"));
  });
});

