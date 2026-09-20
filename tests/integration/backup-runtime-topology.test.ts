import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();

describe("backup runtime production topology", () => {
  it("follows deploy-ecs source/current even when stale generation state exists", () => {
    const root = mkdtempSync(join(tmpdir(), "dx-backup-runtime-"));
    const source = join(root, "source");
    mkdirSync(join(source, "apps/api/src/platform"), { recursive: true });
    mkdirSync(join(root, "frontend/source-releases"), { recursive: true });
    mkdirSync(join(root, "generations"), { recursive: true });

    writeFileSync(join(source, ".gitignore"), "/release-manifest.json\n");
    writeFileSync(join(source, "tracked.txt"), "fixture\n");
    writeFileSync(
      join(source, "apps/api/src/platform/migration-manifest.json"),
      JSON.stringify({ migrations: [{ version: "0203_fixture", checksum: "a".repeat(64) }] }),
    );

    execFileSync("git", ["init", "-q"], { cwd: source });
    execFileSync("git", ["config", "user.email", "fixture@example.invalid"], { cwd: source });
    execFileSync("git", ["config", "user.name", "Fixture"], { cwd: source });
    execFileSync("git", ["add", "."], { cwd: source });
    execFileSync("git", ["commit", "-qm", "fixture"], { cwd: source });
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" }).trim();

    writeFileSync(
      join(source, "release-manifest.json"),
      JSON.stringify({ gitSha: sha, schemaVersion: "0203_fixture", appBasePath: "/" }),
    );

    const web = join(root, "frontend/source-releases", sha);
    mkdirSync(web, { recursive: true });
    writeFileSync(
      join(web, "release-manifest.json"),
      JSON.stringify({ gitSha: sha, schemaVersion: "0203_fixture", appBasePath: "/" }),
    );

    symlinkSync(source, join(root, "current"));
    mkdirSync(join(root, "frontend"), { recursive: true });
    symlinkSync(web, join(root, "frontend/current"));

    const staleSha = "b".repeat(40);
    mkdirSync(join(root, "generations", staleSha), { recursive: true });
    symlinkSync(join(root, "generations", staleSha), join(root, "active"));

    const result = spawnSync(
      "bash",
      ["-c", [
        "source scripts/deploy/lib.sh",
        "source scripts/deploy/backup-runtime.sh",
        "resolve_backup_runtime",
        "printf \"%s|%s|%s\\n\" \"$active_mode\" \"$active_sha\" \"$active_api\"",
      ].join("; ")],
      {
        cwd: repoRoot,
        encoding: "utf8",
        env: { ...process.env, DX_REWORK_ROOT: root },
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("source|" + sha + "|" + source);
  });

  it("keeps the backup resolver aligned with the actual ECS deploy script", () => {
    const deploy = readFileSync(join(repoRoot, "scripts/deploy-ecs.sh"), "utf8");
    const resolver = readFileSync(join(repoRoot, "scripts/deploy/backup-runtime.sh"), "utf8");

    expect(deploy).toContain('ln -sfn "$SOURCE_ROOT" "$DX_ROOT/current"');
    expect(deploy).toContain('WEB_RELEASE_ROOT="$DX_ROOT/frontend/source-releases"');
    expect(resolver).toContain('if [[ "$active_api" == "$DX_ROOT/source" ]]');
    expect(resolver).toContain('$DX_ROOT/frontend/source-releases/$active_sha');
    expect(resolver).toContain("active_mode=source");
  });
});
