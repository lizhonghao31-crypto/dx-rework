import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = process.cwd();
const oldSha = "1111111111111111111111111111111111111111";
const newSha = "2222222222222222222222222222222222222222";

function writeExecutable(path: string, body: string): void {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

describe("PR-17 bounded review fixes", () => {
  it("clears ambient selected values that are omitted from an authoritative env file", () => {
    const directory = mkdtempSync(join(tmpdir(), "pr17-env-clear-"));
    const file = join(directory, "empty.env");
    writeFileSync(file, "# intentionally empty\n");
    chmodSync(file, 0o600);
    const result = spawnSync(
      "bash",
      [
        "-c",
        `source scripts/deploy/lib.sh; export DATABASE_URL=postgresql://stale APPROVED=stale; load_env_file '${file}' "$(id -un)" "$DX_REWORK_APP_ENV_KEYS"; [[ ! -v DATABASE_URL ]]`,
      ],
      { cwd: repositoryRoot, encoding: "utf8" },
    );
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  });

  it("enters maintenance when a migration command partially advances database state", () => {
    const root = mkdtempSync(join(tmpdir(), "pr17-partial-migration-"));
    const api = join(root, "api");
    const shared = join(root, "shared");
    const fakeNode = join(root, "node22");
    const state = join(root, "state.json");
    mkdirSync(join(api, "scripts", "deploy"), { recursive: true });
    mkdirSync(shared, { recursive: true });
    writeFileSync(state, JSON.stringify({ count: 1, version: "0001_a", checksum: "a" }));
    writeExecutable(
      fakeNode,
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == */scripts/migrate.mjs ]]; then
  printf '%s' '{"count":2,"version":"0002_b","checksum":"b"}' > "${state}"
  exit 42
fi
if [[ "\${1:-}" == */database-state.mjs && "\${2:-}" == print-current ]]; then
  cat "${state}"
  exit 0
fi
exit 1
`,
    );
    const before = JSON.stringify({ count: 1, version: "0001_a", checksum: "a" });
    const result = spawnSync(
      "bash",
      ["scripts/deploy/apply-migrations-safely.sh", api, before],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          DATABASE_URL: "postgresql://fixture/fixture",
          DX_REWORK_ROOT: root,
          DX_REWORK_NODE_BIN: fakeNode,
        },
      },
    );
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("partial database change");
    expect(existsSync(join(shared, "release-switch.lock"))).toBe(true);
  });

  it("uses one active generation pointer and a request-time maintenance gate", () => {
    const activation = readFileSync("scripts/deploy/activate-release.sh", "utf8");
    const nginx = readFileSync("infra/nginx/dx-rework.conf.example", "utf8");
    expect(activation).toContain('atomic_link "$generation" "$DX_ROOT/active"');
    expect(activation).not.toMatch(/atomic_link[^\n]+frontend\/current/);
    expect(nginx).toContain("release-switch.lock");
    expect(nginx.match(/access_log \/opt\/dx-rework\/logs\/nginx-access\.log dx_rework_query_free;/g)).toHaveLength(2);
  });

  it("rejects executed UAT evidence from a different release Head", () => {
    const matrix = JSON.parse(
      readFileSync("docs/operations/pr-17-acceptance-matrix.json", "utf8"),
    ) as { items: Array<Record<string, unknown>> };
    Object.assign(matrix.items[0], {
      result: "passed",
      gitSha: oldSha,
      schemaVersion: "0032_fixture",
      executedAt: "2026-08-06T00:00:00.000Z",
      environment: "isolated",
      testDataIds: ["fixture-1"],
      roles: ["worker"],
      steps: ["execute"],
      expected: "pass",
      actual: "pass",
      evidenceRefs: ["evidence://fixture"],
      executor: "executor-a",
      reviewer: "reviewer-b",
      defectLinks: [],
    });
    const directory = mkdtempSync(join(tmpdir(), "pr17-uat-head-"));
    const file = join(directory, "matrix.json");
    writeFileSync(file, JSON.stringify(matrix));
    const result = spawnSync(
      "node",
      ["scripts/acceptance/validate.mjs", file, newSha],
      { cwd: repositoryRoot, encoding: "utf8" },
    );
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("does not match the release Head");
  });
});
