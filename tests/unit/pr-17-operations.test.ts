import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");

type AcceptanceItem = {
  id: string;
  result: "not_run" | "passed" | "failed" | "blocked";
  gitSha: string;
  [key: string]: unknown;
};

const validateAcceptanceMatrix = (matrixPath: string, items: AcceptanceItem[]) => {
  const executed = items.filter((item) => item.result !== "not_run");
  const executedShas = [...new Set(executed.map((item) => item.gitSha))];
  if (executed.length > 0) {
    expect(executedShas).toHaveLength(1);
    expect(executedShas[0]).toMatch(/^[0-9a-f]{40}$/);
  }
  return spawnSync("node", [
    "scripts/acceptance/validate.mjs",
    matrixPath,
    ...(executedShas[0] ? [executedShas[0]] : []),
  ]);
};

const completeFirstItem = (
  matrix: { items: AcceptanceItem[] },
  overrides: Record<string, unknown> = {},
) => {
  const releaseSha = "a".repeat(40);
  Object.assign(matrix.items[0]!, {
    result: "passed",
    environment: "isolated-uat",
    gitSha: releaseSha,
    schemaVersion: "0038_worker_person_materialization",
    testDataIds: ["synthetic-uat-01"],
    roles: ["executor", "reviewer"],
    steps: ["execute scenario"],
    expected: "scenario passes",
    actual: "scenario passed",
    evidenceRefs: ["evidence://synthetic"],
    executor: "executor-user",
    reviewer: "reviewer-user",
    executedAt: "2026-08-09T00:00:00.000Z",
    defectLinks: [],
    ...overrides,
  });
  return releaseSha;
};

describe("PR-17 operations evidence", () => {
  it("has exactly ordered UAT-01 through UAT-22 and accepts only validator-backed evidence", () => {
    const matrix = JSON.parse(read("docs/operations/pr-17-acceptance-matrix.json")) as { items: AcceptanceItem[] };
    expect(matrix.items).toHaveLength(22);
    expect(matrix.items.map((item) => item.id)).toEqual(
      Array.from({ length: 22 }, (_, index) => `UAT-${String(index + 1).padStart(2, "0")}`),
    );
    expect(validateAcceptanceMatrix(
      "docs/operations/pr-17-acceptance-matrix.json",
      matrix.items,
    ).status).toBe(0);
  });

  it("rejects passed evidence without two independent people", () => {
    const matrix = JSON.parse(read("docs/operations/pr-17-acceptance-matrix.json")) as { items: AcceptanceItem[] };
    const releaseSha = completeFirstItem(matrix, {
      executor: "same",
      reviewer: " same ",
    });
    const path = join(mkdtempSync(join(tmpdir(), "pr17-uat-")), "matrix.json");
    writeFileSync(path, JSON.stringify(matrix));
    expect(spawnSync("node", [
      "scripts/acceptance/validate.mjs",
      path,
      releaseSha,
    ]).status).not.toBe(0);
  });

  it("rejects placeholder evidence references instead of accepting a cosmetic pass", () => {
    const matrix = JSON.parse(read("docs/operations/pr-17-acceptance-matrix.json")) as { items: AcceptanceItem[] };
    const releaseSha = completeFirstItem(matrix, { evidenceRefs: ["TBD-evidence"] });
    const path = join(mkdtempSync(join(tmpdir(), "pr17-uat-placeholder-")), "matrix.json");
    writeFileSync(path, JSON.stringify(matrix));
    expect(spawnSync("node", [
      "scripts/acceptance/validate.mjs",
      path,
      releaseSha,
    ]).status).not.toBe(0);
  });

  it("manual workflow packages exact main without repeating the full CI suite", () => {
    const workflow = read(".github/workflows/pr-17-release.yml");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).not.toMatch(/^\s+(push|pull_request):/m);
    expect(workflow).toContain("default: true");
    expect(workflow).toContain("permissions:\n  contents: read");
    expect(workflow).toContain("concurrency:");
    expect(workflow).toContain("environment:");
    expect(workflow).toContain("APP_BASE_PATH: /rework/");
    expect(workflow).toContain("VITE_BASE_PATH: /rework/");
    expect(workflow).toContain("run: npm run build");
    expect(workflow).toContain("scripts/deploy/package-release.sh");
    expect(workflow).not.toContain("npm test");
    expect(workflow).not.toContain("npm run preview:dry-run");
    expect(workflow).not.toContain("services:\n      postgres:");
    expect(workflow).toContain("< scripts/deploy/remote-release.sh");
    expect(workflow).not.toContain("<<'REMOTE'");
    expect(workflow).not.toContain("<<'PY'");
    expect(workflow).toContain("StrictHostKeyChecking=yes");
    expect(workflow).not.toContain("StrictHostKeyChecking=no");
    expect(workflow).not.toMatch(/artifact[\s\S]{0,200}(\.env|DATABASE_URL|SSH_KEY)/);
  });

  it("roadmap identifies merged predecessors and the remaining PR-17 OSS runtime blocker", () => {
    const roadmap = read("docs/plan/pr-roadmap-v2.0.md");
    for (const id of ["PR-12", "PR-13", "PR-14", "PR-15", "PR-16"]) {
      expect(roadmap).toMatch(new RegExp(`\\| ${id} \\|.*已完成；GitHub #`));
    }
    expect(roadmap).toMatch(/\| PR-17 \|.*施工中；GitHub #27/);
    expect(roadmap).toContain("PR-17 A 阶段大部分仓库施工已合并");
    expect(roadmap).toContain("OSS 生产运行时接线仍是明确的仓库侧阻塞");
    expect(roadmap).toContain("B 阶段隔离运行时验证在 OSS 接线完成后继续");
    expect(roadmap).toContain("未在真实环境执行的项目保持未通过");
  });

  it("documents isolated restore, S-04 and two-worker Guangzhou pilot", () => {
    const pilot = read("docs/operations/pr-17-pilot-training.md");
    expect(pilot).toMatch(/达兴广州尾部.*少量工序.*2 名工人/s);
    expect(pilot).toContain("约 2 小时");
    expect(pilot).toMatch(/S-04.*试点前.*书面关闭/);

    const runbook = read("docs/operations/pr-17-release-runbook.md");
    expect(runbook).toMatch(/隔离恢复|隔离库/);
    expect(runbook).toMatch(/RPO\/RTO/);
    expect(runbook).toContain("不执行 `nginx -s reload`");
  });
});
