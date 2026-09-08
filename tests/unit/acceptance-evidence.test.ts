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
        checks: [{ key: "worker-a:http:x", category: "http", label: "x", expected: "HTTP 403", actual: "HTTP 200", verdict: "fail" }],
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

  it("defines representative scenarios with mandatory read-only preflights", () => {
    expect(ACCEPTANCE_SCENARIOS.map((scenario) => scenario.id)).toEqual(expect.arrayContaining([
      "finance-director-sample-readonly",
      "warehouse-order-date-filter",
      "owner-todo-inbox",
      "worker-module-boundary",
    ]));
    expect(ACCEPTANCE_SCENARIOS.every((scenario) => scenario.preflight.path.length > 0)).toBe(true);
    expect(ACCEPTANCE_SCENARIOS.every((scenario) => Number.isInteger(scenario.preflight.expectedStatus))).toBe(true);
    expect(ACCEPTANCE_SCENARIOS.find((scenario) => scenario.id === "owner-todo-inbox")?.preflight.path).toBe("todos/mine?page=1");
  });

  it("redacts secret-shaped scenario notes before evidence can be persisted or exported", () => {
    const report = createAcceptanceEvidenceReport(new Date("2026-09-08T14:00:00.000Z"));
    const secretBearer = "super-secret-bearer-token";
    const secretSession = "0123456789012345678901234567890123456789012";
    const dirty = `Authorization: Bearer ${secretBearer}; Cookie: dx_rework_session=${secretSession}; control_code=never-export-me`;
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
    expect(serialized).not.toContain(secretSession);
    expect(serialized).not.toContain("never-export-me");
    expect(serialized).toContain("REDACTED");
    expect(redactAcceptanceEvidenceText(dirty)).not.toContain(secretBearer);
  });

  it("parses only the versioned report shape and sanitizes parsed evidence", () => {
    const report = createAcceptanceEvidenceReport(new Date("2026-09-08T14:00:00.000Z"));
    expect(parseAcceptanceEvidenceReport(JSON.stringify(report))?.reportId).toBe(report.reportId);
    expect(parseAcceptanceEvidenceReport('{"formatVersion":2}')).toBeNull();
    expect(parseAcceptanceEvidenceReport("not-json")).toBeNull();
  });
});
