import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");

describe("PR-17 operations evidence", () => {
  it("has exactly ordered UAT-01 through UAT-22 with no fabricated pass", () => {
    const matrix = JSON.parse(read("docs/operations/pr-17-acceptance-matrix.json"));
    expect(matrix.items).toHaveLength(22);
    expect(matrix.items.map((item: { id: string }) => item.id)).toEqual(
      Array.from({ length: 22 }, (_, index) => `UAT-${String(index + 1).padStart(2, "0")}`),
    );
    expect(matrix.items.every((item: { result: string }) => item.result === "not_run")).toBe(true);
    expect(
      spawnSync("node", [
        "scripts/acceptance/validate.mjs",
        "docs/operations/pr-17-acceptance-matrix.json",
      ]).status,
    ).toBe(0);
  });

  it("rejects passed evidence without two independent people and evidence", () => {
    const matrix = JSON.parse(read("docs/operations/pr-17-acceptance-matrix.json"));
    matrix.items[0].result = "passed";
    matrix.items[0].executor = "same";
    matrix.items[0].reviewer = "same";
    const path = join(mkdtempSync(join(tmpdir(), "pr17-uat-")), "matrix.json");
    writeFileSync(path, JSON.stringify(matrix));
    expect(spawnSync("node", ["scripts/acceptance/validate.mjs", path]).status).not.toBe(0);
  });

  it("manual workflow is dry by default and tightly scoped", () => {
    const workflow = read(".github/workflows/pr-17-release.yml");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).not.toMatch(/^\s+(push|pull_request):/m);
    expect(workflow).toContain("default: true");
    expect(workflow).toContain("permissions:\n  contents: read");
    expect(workflow).toContain("concurrency:");
    expect(workflow).toContain("environment:");
    expect(workflow).toContain("StrictHostKeyChecking=yes");
    expect(workflow).not.toContain("StrictHostKeyChecking=no");
    expect(workflow).not.toMatch(/artifact[\s\S]{0,200}(\.env|DATABASE_URL|SSH_KEY)/);
  });

  it("roadmap identifies merged predecessors and PR-17 current work", () => {
    const roadmap = read("docs/plan/pr-roadmap-v2.0.md");
    for (const id of ["PR-12", "PR-13", "PR-14", "PR-15", "PR-16"]) {
      expect(roadmap).toMatch(new RegExp(`\\| ${id} \\|.*已完成；GitHub #`));
    }
    expect(roadmap).toMatch(/\| PR-17 \|.*施工中；GitHub #27/);
    expect(roadmap).toContain("PR-17 A 阶段");
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
