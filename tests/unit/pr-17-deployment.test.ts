import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const run = (code: string, env: Record<string, string> = {}) =>
  spawnSync("bash", ["-c", `source scripts/deploy/lib.sh; ${code}`], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });

describe("PR-17 deployment fail-closed contract", () => {
  it("accepts only a full lowercase SHA", () => {
    expect(run("require_sha 0123456789abcdef0123456789abcdef01234567").status).toBe(0);
    for (const value of [
      "",
      "abc",
      "A123456789abcdef0123456789abcdef01234567",
      "0123456789abcdef0123456789abcdef0123456*",
    ]) {
      expect(run(`require_sha '${value}'`).status).not.toBe(0);
    }
  });

  it("rejects empty, control, glob and traversal values", () => {
    for (const value of ["", "../x", "a*b", "a?b", "a[bc]"]) {
      expect(run(`reject_unsafe_value '${value}'`).status).not.toBe(0);
    }
    expect(run("reject_unsafe_value $'a\\nb'").status).not.toBe(0);
  });

  it("rejects relative, escaped, ERP/sample and symlink paths", () => {
    const directory = mkdtempSync(join(tmpdir(), "pr17-path-"));
    mkdirSync(join(directory, "ok"));
    symlinkSync("/tmp", join(directory, "ok", "link"));
    for (const path of [
      "relative",
      "/opt/daxing-erp/x",
      "/opt/daxing-sample/x",
      `${directory}/../escape`,
      `${directory}/ok/link/x`,
    ]) {
      expect(run(`assert_safe_path '${path}' '${directory}'`).status).not.toBe(0);
    }
  });

  it("redacts credentials and sensitive query/header data", () => {
    const result = run(
      "safe_log fail 'postgresql://user:pass@host/db?token=abc&signature=xyz Authorization=Bearer123 session=q'",
    );
    expect(result.stdout).not.toMatch(/pass@|abc|xyz|Bearer123|session=q/);
    expect(result.stdout).toContain("REDACTED");
  });

  it("all shell scripts parse", () => {
    const files = execFileSync("bash", ["-c", "find scripts -type f -name '*.sh' -print0"], {
      cwd: root,
    })
      .toString()
      .split("\0")
      .filter(Boolean);
    for (const file of files) {
      expect(spawnSync("bash", ["-n", file], { cwd: root }).status, file).toBe(0);
    }
  });

  it("forbids broad process control, unscoped Nginx reload, unsafe SSH and foreign writes", () => {
    const files = execFileSync("bash", ["-c", "find scripts/deploy -type f -name '*.sh' -print"], {
      cwd: root,
      encoding: "utf8",
    })
      .trim()
      .split("\n");
    const body = files.map((file) => readFileSync(join(root, file), "utf8")).join("\n");
    expect(body).not.toMatch(
      /pm2\s+(kill|delete all|restart all)|StrictHostKeyChecking=no|rm\s+-rf\s+\/opt\/daxing/,
    );
    // Only the installed root release controllers may reload nginx after
    // replacing the approved dedicated vhost and validating nginx -t.
    const controllers = new Set([
      "scripts/deploy/update-main-online.sh",
      "scripts/deploy/update-main-maintenance.sh",
    ]);
    for (const file of files.filter((file) => !controllers.has(file))) {
      expect(readFileSync(join(root, file), "utf8"), file).not.toMatch(/nginx\s+-s\s+reload/);
    }
    expect(body).not.toContain("eval ");
  });
});
