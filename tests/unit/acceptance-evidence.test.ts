import { describe, expect, it } from "vitest";

import {
  ACCEPTANCE_SCENARIOS,
  acceptanceEvidenceSummary,
  appendMatrixEvidence,
  appendScenarioEvidence,
  createAcceptanceEvidenceReport,
  firstFailureForScenario,
  parseAcceptanceEvidenceReport,
  redactAcceptanceEvidenceText,
} from "../../apps/web/src/acceptance-evidence.js";

describe("acceptance evidence report", () => {
  it("keeps first failures when later attempts pass", () => {
    const created = createAcceptanceEvidenceReport(new Date("2026-09-08T14:00:00.000Z"));
    const preflight = {
      method: "GET" as const,
      path: "receiving/board?page=1",
      expectedStatus: 200,
      actualStatus: 200,
    };
    const failed = appendScenarioEvidence(created, {
      scenarioId: "warehouse-order-date-filter",
      alias: "warehouse",
      status: "fail",
      actual: "开始日期被结束日期遮挡",
      recordedAt: "2026-09-08T14:01:00.000Z",
      version: null,
      preflight,
    }, new Date("2026-09-08T14:01:00.000Z"));
    const passed = appendScenarioEvidence(failed, {
      scenarioId: "warehouse-order-date-filter",
      alias: "warehouse",
      status: "pass",
      actual: "修复后两个日期均可正常点击",
      recordedAt: "2026-09-08T14:02:00.000Z",
      version: null,
      preflight,
    }, new Date("2026-09-08T14:02:00.000Z"));

    expect(passed.scenarioAttempts).toHaveLength(2);
    expect(firstFailureForScenario(passed, "warehouse-order-date-filter")?.actual).toContain("遮挡");
    expect(acceptanceEvidenceSummary(passed).historicalFailures).toBe(1);
    expect(acceptanceEvidenceSummary(passed).scenarios.pass).toBe(1);
  });

  it("appends matrix attempts with version and request evidence instead of overwriting", () => {
    const base = createAcceptanceEvidenceReport(new Date("2026-09-08T14:00:00.000Z"));
    const first = appendMatrixEvidence(base, {
      startedAt: "2026-09-08T14:03:00.000Z",
      completedAt: "2026-09-08T14:04:00.000Z",
      version: { gitSha: "abc", buildTime: "now", schemaVersion: "0160", expectedSchemaVersion: "0160" },
      results: [{
        alias: "worker-a",
        checks: [{
          key: "worker-a:http:x", category: "http", label: "x",
          expected: "HTTP 403", actual: "HTTP 200", verdict: "fail",
          ruleId: "PERM-TEST-001", ruleStatus: "approved",
        }],
        requests: [{ method: "GET", path: "samples?page=1", expectedStatus: 403, actualStatus: 200 }],
      }],
    }, new Date("2026-09-08T14:04:00.000Z"));
    const second = appendMatrixEvidence(first, {
      startedAt: "2026-09-08T14:05:00.000Z",
      completedAt: "2026-09-08T14:06:00.000Z",
      version: null,
      results: [],
    }, new Date("2026-09-08T14:06:00.000Z"));

    expect(second.matrixAttempts).toHaveLength(2);
    expect(second.matrixAttempts[0]?.results[0]?.requests[0]?.path).toBe("samples?page=1");
    expect(second.matrixAttempts[0]?.version?.gitSha).toBe("abc");
  });

  it("reports approved pass/fail separately from standards that are still pending", () => {
    const report = appendMatrixEvidence(
      createAcceptanceEvidenceReport(new Date("2026-09-08T14:00:00.000Z")),
      {
        startedAt: "2026-09-08T14:03:00.000Z",
        completedAt: "2026-09-08T14:04:00.000Z",
        version: null,
        results: [{
          alias: "tail-supervisor",
          requests: [],
          checks: [
            {
              key: "pass", category: "module", label: "pass", expected: "x", actual: "x", verdict: "pass",
              ruleId: "PERM-APPROVED-001", ruleStatus: "approved",
            },
            {
              key: "fail", category: "module", label: "fail", expected: "x", actual: "y", verdict: "fail",
              ruleId: "PERM-APPROVED-002", ruleStatus: "approved",
            },
            {
              key: "pending", category: "http", label: "pending", expected: "HTTP 403", actual: "HTTP 200", verdict: "pending",
              ruleId: "PERM-SUPPLIER-TAIL-001", ruleStatus: "pending",
            },
          ],
        }],
      },
      new Date("2026-09-08T14:04:00.000Z"),
    );
    const summary = acceptanceEvidenceSummary(report);
    expect(summary.matrixTotal).toBe(3);
    expect(summary.matrixPassed).toBe(1);
    expect(summary.matrixFailed).toBe(1);
    expect(summary.matrixPending).toBe(1);
  });

  it("quarantines a pending manual scenario so it cannot become green or red evidence", () => {
    const base = createAcceptanceEvidenceReport(new Date("2026-09-08T14:00:00.000Z"));
    const withWorker = appendScenarioEvidence(base, {
      scenarioId: "worker-module-boundary",
      alias: "worker-a",
      status: "fail",
      actual: "看到了供应商入口",
      recordedAt: "2026-09-08T14:01:00.000Z",
      version: null,
      preflight: {
        method: "GET",
        path: "frontline/work-tasks?kind=worker",
        expectedStatus: 200,
        actualStatus: 200,
      },
    }, new Date("2026-09-08T14:01:00.000Z"));
    const attempt = withWorker.scenarioAttempts[0]!;
    expect(attempt.ruleId).toBe("PERM-PLATFORM-WORKER-CROSSMODULE-001");
    expect(attempt.ruleStatus).toBe("pending");
    expect(attempt.status).toBe("not_run");
    expect(attempt.actual).toContain("标准待确认");
    expect(firstFailureForScenario(withWorker, "worker-module-boundary")).toBeUndefined();
    const summary = acceptanceEvidenceSummary(withWorker);
    expect(summary.scenarios.pass).toBe(0);
    expect(summary.scenarios.fail).toBe(0);
    expect(summary.scenarios.pending).toBe(1);
    expect(summary.historicalFailures).toBe(0);
  });

  it("defines representative scenarios with mandatory read-only preflights and explicit governance", () => {
    expect(ACCEPTANCE_SCENARIOS.map((scenario) => scenario.id)).toEqual(expect.arrayContaining([
      "finance-director-sample-readonly",
      "warehouse-order-date-filter",
      "owner-todo-inbox",
      "worker-module-boundary",
    ]));
    expect(ACCEPTANCE_SCENARIOS.every((scenario) => scenario.preflight.path.length > 0)).toBe(true);
    expect(ACCEPTANCE_SCENARIOS.every((scenario) => Number.isInteger(scenario.preflight.expectedStatus))).toBe(true);
    expect(ACCEPTANCE_SCENARIOS.every((scenario) => scenario.ruleId.length > 0)).toBe(true);
    expect(ACCEPTANCE_SCENARIOS.find((scenario) => scenario.id === "owner-todo-inbox")?.preflight.path).toBe("todos/mine?page=1");
    expect(ACCEPTANCE_SCENARIOS.find((scenario) => scenario.id === "worker-module-boundary")?.ruleStatus).toBe("pending");
  });

  it("redacts complete authorization and cookie values before persistence or export", () => {
    const report = createAcceptanceEvidenceReport(new Date("2026-09-08T14:00:00.000Z"));
    const secretBearer = "super-secret-bearer-token";
    const secretBasic = "dXNlcjp0b3Atc2VjcmV0";
    const secretCookie = "cookie-secret-value";
    const secretSession = "0123456789012345678901234567890123456789012";
    const dirty = [
      `Authorization: Bearer ${secretBearer}`,
      `Authorization: Basic ${secretBasic}`,
      `Cookie: theme=dark; session=${secretCookie}; dx_rework_session=${secretSession}`,
      "control_code=never-export-me",
    ].join("\n");
    const withAttempt = appendScenarioEvidence(report, {
      scenarioId: "owner-todo-inbox",
      alias: "owner",
      status: "blocked",
      actual: dirty,
      recordedAt: "2026-09-08T14:01:00.000Z",
      version: null,
      preflight: { method: "GET", path: "todos/mine?page=1", expectedStatus: 200, actualStatus: 200 },
    }, new Date("2026-09-08T14:01:00.000Z"));

    const serialized = JSON.stringify(withAttempt);
    expect(serialized).not.toContain(secretBearer);
    expect(serialized).not.toContain(secretBasic);
    expect(serialized).not.toContain(secretCookie);
    expect(serialized).not.toContain(secretSession);
    expect(serialized).not.toContain("theme=dark");
    expect(serialized).not.toContain("never-export-me");
    expect(serialized).toContain("REDACTED");
    expect(redactAcceptanceEvidenceText(dirty)).not.toContain(secretBearer);
  });

  it("rejects legacy v1 reports so old ungoverned verdicts cannot survive deployment", () => {
    const legacy = {
      formatVersion: 1,
      reportId: "acceptance-legacy",
      createdAt: "2026-09-08T14:00:00.000Z",
      updatedAt: "2026-09-08T14:00:00.000Z",
      matrixAttempts: [{
        attemptId: "legacy",
        startedAt: "2026-09-08T14:00:00.000Z",
        completedAt: "2026-09-08T14:01:00.000Z",
        version: null,
        results: [{
          alias: "worker-a",
          requests: [],
          checks: [{ key: "legacy", category: "http", label: "legacy", expected: "403", actual: "200", verdict: "fail" }],
        }],
      }],
      scenarioAttempts: [],
    };
    expect(parseAcceptanceEvidenceReport(JSON.stringify(legacy))).toBeNull();
  });

  it("parses only governed v2 reports and sanitizes parsed evidence", () => {
    const report = createAcceptanceEvidenceReport(new Date("2026-09-08T14:00:00.000Z"));
    expect(report.formatVersion).toBe(2);
    expect(parseAcceptanceEvidenceReport(JSON.stringify(report))?.reportId).toBe(report.reportId);
    expect(parseAcceptanceEvidenceReport('{"formatVersion":1}')).toBeNull();
    expect(parseAcceptanceEvidenceReport("not-json")).toBeNull();
  });
});
