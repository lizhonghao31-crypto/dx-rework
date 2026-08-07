import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("ECS one-command deployment entry", () => {
  it("builds, migrates, reloads and verifies from the checked-out main source", async () => {
    const script = await readFile("scripts/deploy-ecs.sh", "utf8");
    expect(script).toContain('[[ "$branch" == "main" ]]');
    expect(script).toContain("npm ci");
    expect(script).toContain("package-release.sh");
    expect(script).toContain("scripts/migrate.mjs");
    expect(script).toContain("pm2 startOrReload");
    expect(script).toContain("http://127.0.0.1:3201/health/ready");
  });
});
