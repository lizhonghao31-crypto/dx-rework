import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("ECS one-command deployment entry", () => {
  it("uses an ERP-style persistent source build and direct runtime switch", async () => {
    execFileSync("bash", ["-n", "scripts/deploy-ecs.sh"]);
    const script = await readFile("scripts/deploy-ecs.sh", "utf8");
    expect(script).toContain("EXPECTED_ORIGIN='git@github.com:lizhonghao31-crypto/dx-rework.git'");
    expect(script).toContain("git fetch origin main");
    expect(script).toContain('[[ "$sha" == "$remote_sha" ]]');
    expect(script).toContain('DEPS_MARKER="$DX_ROOT/shared/build-package-lock.sha256"');
    expect(script).toContain("reuse persistent source node_modules");
    expect(script).toContain("bootstrap source build dependencies from local current release");
    expect(script).toContain("npm run build");
    expect(script).toContain("scripts/migrate.mjs");
    expect(script).toContain('ln -sfn "$SOURCE_ROOT" "$DX_ROOT/current"');
    expect(script).toContain('ln -sfn "$web_target" "$DX_ROOT/frontend/current"');
    expect(script).toContain("pm2 startOrReload");
    expect(script).toContain("http://127.0.0.1:3201/health/ready");
    expect(script).not.toContain("package-release.sh");
    expect(script).not.toContain("scripts/deploy/release.sh");
  });
});
