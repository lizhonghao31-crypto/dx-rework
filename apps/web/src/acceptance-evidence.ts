import type { AcceptanceMatrixCheck } from "./acceptance-matrix.js";

export type AcceptanceEvidenceStatus = "pass" | "fail" | "blocked" | "not_run";

export type AcceptanceRuntimeVersion = Readonly<{
  gitSha: string;
  buildTime: string;
  schemaVersion: string | null;
  expectedSchemaVersion: string;
}>;

export type AcceptanceRequestEvidence = Readonly<{
  method: "GET" | "POST";
  path: string;
  expectedStatus: number;
  actualStatus: number;
}>;

export type AcceptanceMatrixEvidence = Readonly<{
  attemptId: string;
  startedAt: string;
  completedAt: string;
  version: AcceptanceRuntimeVersion | null;
  results: readonly Readonly<{
    alias: string;
    checks: readonly AcceptanceMatrixCheck[];
    requests: readonly AcceptanceRequestEvidence[];
  }>[];
}>;

export type AcceptanceScenarioDefinition = Readonly<{
  id: string;
  title: string;
  kind: "browser" | "business" | "todo";
  alias: string;
  route: string;
  expected: string;
  steps: readonly string[];
  preflight: Readonly<{ path: string; expectedStatus: number }>;
}>;

export type AcceptanceScenarioEvidence = Readonly<{
  attemptId: string;
  scenarioId: string;
  alias: string;
  status: AcceptanceEvidenceStatus;
  actual: string;
  recordedAt: string;
  version: AcceptanceRuntimeVersion | null;
  preflight: AcceptanceRequestEvidence;
}>;

export type AcceptanceEvidenceReport = Readonly<{
  formatVersion: 1;
  reportId: string;
  createdAt: string;
  updatedAt: string;
  matrixAttempts: readonly AcceptanceMatrixEvidence[];
  scenarioAttempts: readonly AcceptanceScenarioEvidence[];
}>;

const newId = (prefix: string, now = new Date()): string =>
  `${prefix}-${now.toISOString().replace(/[-:.TZ]/g, "")}-${Math.random().toString(36).slice(2, 8)}`;

const EVIDENCE_SECRET_PATTERNS: readonly Readonly<{ pattern: RegExp; replacement: string }>[] = [
  {
    pattern: /\b((?:proxy-)?authorization\s*[:=]\s*)[^\r\n;]*/gi,
    replacement: "$1[REDACTED]",
  },
  { pattern: /\b(cookie\s*[:=]\s*)[^\r\n]*/gi, replacement: "$1[REDACTED]" },
  { pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, replacement: "Bearer [REDACTED]" },
  { pattern: /\b(dx_(?:rework_session|acceptance_control)\s*=\s*)[^;\s]+/gi, replacement: "$1[REDACTED]" },
  {
    pattern: /\b((?:token|control(?:[_\s-]?(?:credential|code))?)\s*[:=]\s*)[^\r\n;]*/gi,
    replacement: "$1[REDACTED]",
  },
  { pattern: /\b[A-Za-z0-9_-]{20,}\.[0-9a-f]{64}\b/gi, replacement: "[REDACTED_ACCEPTANCE_CODE]" },
  { pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, replacement: "[REDACTED_JWT]" },
  { pattern: /\b[A-Za-z0-9_-]{43}\b/g, replacement: "[REDACTED_SESSION]" },
];

export function redactAcceptanceEvidenceText(value: string): string {
  return EVIDENCE_SECRET_PATTERNS.reduce(
    (current, entry) => current.replace(entry.pattern, entry.replacement),
    value,
  );
}

export function sanitizeAcceptanceEvidenceReport(report: AcceptanceEvidenceReport): AcceptanceEvidenceReport {
  return {
    ...report,
    scenarioAttempts: report.scenarioAttempts.map((attempt) => ({
      ...attempt,
      actual: redactAcceptanceEvidenceText(attempt.actual),
    })),
  };
}

export const ACCEPTANCE_SCENARIOS: readonly AcceptanceScenarioDefinition[] = [
  {
    id: "finance-director-sample-readonly",
    title: "财务总监样衣只读",
    kind: "browser",
    alias: "finance-director",
    route: "ui/samples",
    expected: "可以查看样衣基本、财务和审计信息；不得出现新增、修改、交接、处置、审批或归档能力。",
    steps: [
      "切换为财务总监后，用新窗口打开样衣模块。",
      "正常点击目录和一条样衣详情，确认财务信息可见。",
      "确认页面没有新增、修改、借还确认、处置、审批、归档等写操作入口。",
    ],
    preflight: { path: "samples?page=1", expectedStatus: 200 },
  },
  {
    id: "warehouse-order-date-filter",
    title: "仓管订单回货日期筛选",
    kind: "browser",
    alias: "warehouse",
    route: "ui/orders",
    expected: "开始日期和结束日期均可用正常点击选择，互不遮挡；无导出权限时布局仍稳定。",
    steps: [
      "切换为仓管后打开订单回货。",
      "不用 force click 或 DOM 注入，正常点击开始日期并选择日期。",
      "再正常点击结束日期，确认两个控件都可操作且没有重叠。",
    ],
    preflight: { path: "receiving/board?page=1", expectedStatus: 200 },
  },
  {
    id: "owner-todo-inbox",
    title: "老板隔离待办收件箱",
    kind: "todo",
    alias: "owner",
    route: "ui/my-tasks",
    expected: "读取的是 UAT 身份在隔离数据库中的真实待办；不向真实员工发送外部通知。",
    steps: [
      "切换为老板验收身份。",
      "读取我的待办并打开待办页面。",
      "确认页面身份仍为 UAT 老板；本场景只读取待办，不触发外部发送。",
    ],
    preflight: { path: "todos/mine?page=1", expectedStatus: 200 },
  },
  {
    id: "worker-module-boundary",
    title: "工人业务入口边界",
    kind: "browser",
    alias: "worker-a",
    route: "ui/frontline",
    expected: "工人只能进入其前线返工工作入口，不应出现供应商、样衣、生产看板或人员权限管理入口。",
    steps: [
      "切换为工人甲。",
      "从当前身份业务页进入前线工作区。",
      "正常浏览导航，确认不存在供应商、样衣、生产看板和人员权限管理入口。",
    ],
    preflight: { path: "frontline/work-tasks?kind=worker", expectedStatus: 200 },
  },
];

export function createAcceptanceEvidenceReport(now = new Date()): AcceptanceEvidenceReport {
  const timestamp = now.toISOString();
  return {
    formatVersion: 1,
    reportId: newId("acceptance", now),
    createdAt: timestamp,
    updatedAt: timestamp,
    matrixAttempts: [],
    scenarioAttempts: [],
  };
}

export function appendMatrixEvidence(
  report: AcceptanceEvidenceReport,
  input: Omit<AcceptanceMatrixEvidence, "attemptId">,
  now = new Date(),
): AcceptanceEvidenceReport {
  return {
    ...report,
    updatedAt: now.toISOString(),
    matrixAttempts: [...report.matrixAttempts, { ...input, attemptId: newId("matrix", now) }],
  };
}

export function appendScenarioEvidence(
  report: AcceptanceEvidenceReport,
  input: Omit<AcceptanceScenarioEvidence, "attemptId">,
  now = new Date(),
): AcceptanceEvidenceReport {
  return {
    ...report,
    updatedAt: now.toISOString(),
    scenarioAttempts: [
      ...report.scenarioAttempts,
      { ...input, actual: redactAcceptanceEvidenceText(input.actual), attemptId: newId("scenario", now) },
    ],
  };
}

export function firstFailureForScenario(
  report: AcceptanceEvidenceReport,
  scenarioId: string,
): AcceptanceScenarioEvidence | undefined {
  return report.scenarioAttempts.find((attempt) => attempt.scenarioId === scenarioId && attempt.status === "fail");
}

export function latestScenarioEvidence(
  report: AcceptanceEvidenceReport,
  scenarioId: string,
): AcceptanceScenarioEvidence | undefined {
  return [...report.scenarioAttempts].reverse().find((attempt) => attempt.scenarioId === scenarioId);
}

export function acceptanceEvidenceSummary(report: AcceptanceEvidenceReport) {
  const latestMatrix = report.matrixAttempts.at(-1);
  const matrixChecks = latestMatrix?.results.flatMap((result) => result.checks) ?? [];
  const latestScenarioById = new Map<string, AcceptanceScenarioEvidence>();
  for (const attempt of report.scenarioAttempts) latestScenarioById.set(attempt.scenarioId, attempt);
  const latestScenarios = [...latestScenarioById.values()];
  return {
    matrixTotal: matrixChecks.length,
    matrixPassed: matrixChecks.filter((check) => check.verdict === "pass").length,
    matrixFailed: matrixChecks.filter((check) => check.verdict === "fail").length,
    matrixPending: matrixChecks.filter((check) => check.verdict === "pending").length,
    scenarios: {
      pass: latestScenarios.filter((attempt) => attempt.status === "pass").length,
      fail: latestScenarios.filter((attempt) => attempt.status === "fail").length,
      blocked: latestScenarios.filter((attempt) => attempt.status === "blocked").length,
      notRun: ACCEPTANCE_SCENARIOS.length - latestScenarios.length
        + latestScenarios.filter((attempt) => attempt.status === "not_run").length,
    },
    historicalFailures: report.scenarioAttempts.filter((attempt) => attempt.status === "fail").length,
  };
}

export function parseAcceptanceEvidenceReport(raw: string | null): AcceptanceEvidenceReport | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<AcceptanceEvidenceReport>;
    if (
      value.formatVersion !== 1
      || typeof value.reportId !== "string"
      || !Array.isArray(value.matrixAttempts)
      || !Array.isArray(value.scenarioAttempts)
    ) return null;
    return sanitizeAcceptanceEvidenceReport(value as AcceptanceEvidenceReport);
  } catch {
    return null;
  }
}
