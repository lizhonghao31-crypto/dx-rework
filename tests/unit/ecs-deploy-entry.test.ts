import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("ECS one-command deployment entry", () => {
  it("is valid bash and keeps the real deploy path intact", async () => {
    execFileSync("bash", ["-n", "scripts/deploy-ecs.sh"]);
    const script = await readFile("scripts/deploy-ecs.sh", "utf8");
    expect(script).toContain('[[ "$branch" == "main" ]]');
    expect(script).toContain("npm ci");
    expect(script).toContain("package-release.sh");
    expect(script).toContain("scripts/migrate.mjs");
    expect(script).toContain("pm2 startOrReload");
    expect(script).toContain("http://127.0.0.1:3201/health/ready");
  });
});
