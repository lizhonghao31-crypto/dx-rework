import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("ECS one-command deployment entry", () => {
  it("builds a package and delegates activation, migration and rollback to release.sh", async () => {
    execFileSync("bash", ["-n", "scripts/deploy-ecs.sh"]);
    const script = await readFile("scripts/deploy-ecs.sh", "utf8");
    expect(script).toContain('[[ "$branch" == "main" ]]');
    expect(script).toContain("npm ci");
    expect(script).toContain("package-release.sh");
    expect(script).toContain('scripts/deploy/release.sh" "$sha" "$bundle"');
    expect(script).toContain("DX_REWORK_APPLY_MIGRATIONS=true");
    expect(script).not.toContain("pm2 startOrReload");
    expect(script).not.toContain("scripts/migrate.mjs");
    expect(script).not.toContain("ln -sfn");
  });

  it("keeps database backup on the migration path instead of every code-only release", async () => {
    const release = await readFile("scripts/deploy/release.sh", "utf8");
    const pendingBlock = release.indexOf('if [[ "$pending" == true ]]; then');
    const backup = release.indexOf('"$script_root/scripts/backup-postgres.sh"');
    expect(pendingBlock).toBeGreaterThan(-1);
    expect(backup).toBeGreaterThan(pendingBlock);
    expect(release).toContain("require_command pg_dump");
    expect(release).toContain("apply-migrations-safely.sh");
    expect(release).toContain("activate-release.sh");
    expect(release).toContain("rollback.sh");
  });
});
