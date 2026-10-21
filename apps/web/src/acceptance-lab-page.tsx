import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button, StatusBadge, Surface } from "@dx-rework/ui";

import { createWebUrls } from "../url-contract.js";
import {
  ACCEPTANCE_SCENARIOS,
  acceptanceEvidenceSummary,
  appendMatrixEvidence,
  appendScenarioEvidence,
  createAcceptanceEvidenceReport,
  firstFailureForScenario,
  latestScenarioEvidence,
  parseAcceptanceEvidenceReport,
  sanitizeAcceptanceEvidenceReport,
  type AcceptanceEvidenceReport,
  type AcceptanceEvidenceStatus,
  type AcceptanceRequestEvidence,
  type AcceptanceRuntimeVersion,
} from "./acceptance-evidence.js";
import {
  ACCEPTANCE_ROLE_MATRIX,
  evaluateAcceptanceSnapshot,
  evaluateHttpProbe,
  type AcceptanceMatrixCheck,
} from "./acceptance-matrix.js";
import type { AuthorizedUser } from "./auth.js";
import { platformLandingTarget } from "./platform-modules.js";
import "./acceptance-lab-page.css";

const { apiUrl, pageUrl } = createWebUrls(import.meta.env.BASE_URL);
const EVIDENCE_STORAGE_KEY = "dx-acceptance:evidence:v1";
const PREFLIGHT_TRANSPORT_FAILURE_STATUS = 0;

type AcceptanceIdentity = Readonly<{
  alias: string;
  userId: string;
  displayName: string;
  active: boolean;
  employed: boolean;
  roleCodes: readonly string[];
  capabilities: readonly string[];
}>;

type LabState = "loading" | "locked" | "ready" | "unavailable";
type MatrixSummary = Readonly<{
  alias: string;
  checks: readonly AcceptanceMatrixCheck[];
  requests: readonly AcceptanceRequestEvidence[];
}>;
type ScenarioDraft = Readonly<{
  scenarioId: string;
  status: AcceptanceEvidenceStatus;
  actual: string;
  preflight: AcceptanceRequestEvidence;
  version: AcceptanceRuntimeVersion | null;
}>;

type VersionPayload = AcceptanceRuntimeVersion & Readonly<{ service?: string }>;

const roleLabels: Readonly<Record<string, string>> = {
  owner_group: "老板",
  production_management: "供应链总监",
  development_clerk: "开发文员",
  pattern_room_tail_inspector: "板房尾查",
  ie_reviewer: "IE",
  tail_supervisor: "尾部主管",
  quality_control: "质检",
  warehouse_receiver: "仓管",
  worker: "工人",
  order_merchandiser: "订单跟单",
  finance_read: "财务全局查看",
  finance_director: "财务总监",
  factory_payables: "加工厂应付会计",
  system_admin: "系统管理员",
  production_reporter: "驻厂生产填报",
  sample_designer: "样衣设计师",
  sample_administrative: "样衣管理员",
  sample_finance: "样衣财务",
  sample_approver: "样衣审批人",
};

const statusLabels: Readonly<Record<AcceptanceEvidenceStatus, string>> = {
  pass: "通过",
  fail: "失败",
  blocked: "受阻",
  not_run: "未执行",
};

const ruleStatusLabel = (check: AcceptanceMatrixCheck): string => {
  if (check.ruleStatus === "infrastructure") return "验收基础设施规则";
  if (check.ruleStatus === "approved") return `${check.ruleId} · 已批准`;
  if (check.ruleStatus === "pending") return `${check.ruleId} · 标准待确认`;
  return `${check.ruleId} · 尚未绑定业务标准`;
};

async function jsonRequest<T>(path: string, init?: RequestInit): Promise<{ status: number; body: T | null }> {
  const response = await fetch(apiUrl(path), {
    credentials: "include",
    cache: "no-store",
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  let body: T | null = null;
  try { body = await response.json() as T; } catch { body = null; }
  return { status: response.status, body };
}

function initialEvidenceReport(): AcceptanceEvidenceReport {
  if (typeof window === "undefined") return createAcceptanceEvidenceReport();
  try {
    return parseAcceptanceEvidenceReport(window.localStorage.getItem(EVIDENCE_STORAGE_KEY))
      ?? createAcceptanceEvidenceReport();
  } catch {
    return createAcceptanceEvidenceReport();
  }
}

function persistEvidenceReport(report: AcceptanceEvidenceReport): void {
  window.localStorage.setItem(
    EVIDENCE_STORAGE_KEY,
    JSON.stringify(sanitizeAcceptanceEvidenceReport(report)),
  );
}

export function AcceptanceLabPage() {
  const [state, setState] = useState<LabState>("loading");
  const [code, setCode] = useState("");
  const [identities, setIdentities] = useState<readonly AcceptanceIdentity[]>([]);
  const [currentUser, setCurrentUser] = useState<AuthorizedUser | null>(null);
  const [busyAlias, setBusyAlias] = useState("");
  const [error, setError] = useState("");
  const [matrixRunning, setMatrixRunning] = useState(false);
  const [matrixProgress, setMatrixProgress] = useState("");
  const [matrixResults, setMatrixResults] = useState<readonly MatrixSummary[]>([]);
  const [runtimeReadFailed,setRuntimeReadFailed]=useState(false);
  const [runtimeVersion, setRuntimeVersion] = useState<AcceptanceRuntimeVersion | null>(null);
  const [evidenceReport, setEvidenceReport] = useState<AcceptanceEvidenceReport>(initialEvidenceReport);
  const evidenceReportRef = useRef(evidenceReport);
  const [scenarioDraft, setScenarioDraft] = useState<ScenarioDraft | null>(null);
  const [scenarioRunning, setScenarioRunning] = useState("");

  useEffect(() => { evidenceReportRef.current = evidenceReport; }, [evidenceReport]);

  const updateEvidence = useCallback((update: (report: AcceptanceEvidenceReport) => AcceptanceEvidenceReport): boolean => {
    const next = sanitizeAcceptanceEvidenceReport(update(evidenceReportRef.current));
    try {
      persistEvidenceReport(next);
    } catch {
      setError("验收证据无法持久保存。本次结果未记入报告，请检查浏览器存储权限或空间后重试。");
      return false;
    }
    evidenceReportRef.current = next;
    setEvidenceReport(next);
    return true;
  }, []);

  const refreshCurrentUser = useCallback(async () => {
    const response = await jsonRequest<{ user?: AuthorizedUser }>("auth/me");
    setCurrentUser(response.status === 200 && response.body?.user ? response.body.user : null);
  }, []);

  const captureRuntimeVersion = useCallback(async (): Promise<AcceptanceRuntimeVersion | null> => {
    setRuntimeReadFailed(false);try {
      const response = await jsonRequest<VersionPayload>("version");
      if (response.status === 200 && response.body?.gitSha && response.body.expectedSchemaVersion) {
        const version: AcceptanceRuntimeVersion = {
          gitSha: response.body.gitSha,
          buildTime: response.body.buildTime,
          schemaVersion: response.body.schemaVersion,
          expectedSchemaVersion: response.body.expectedSchemaVersion,
        };
        setRuntimeVersion(version);
        return version;
      }
    } catch {
      // A failed fresh read must never fall back to a stale version from an earlier attempt.
    }
    setRuntimeVersion(null);setRuntimeReadFailed(true);
    return null;
  }, []);

  const refreshRuntimeVersion = useCallback(async () => {
    await captureRuntimeVersion();
  }, [captureRuntimeVersion]);

  const refreshControl = useCallback(async () => {
    setError("");
    try{const response = await jsonRequest<{ identities?: readonly AcceptanceIdentity[] }>("acceptance/control/status");
    if (response.status === 404) {
      setState("unavailable"); setIdentities([]); return;
    }
    if (response.status === 401) {
      setState("locked"); setIdentities([]); return;
    }
    if (response.status !== 200 || !Array.isArray(response.body?.identities)) {
      setState("locked"); setError("验收控制状态尚未读取，不能据此判断凭证失效；请重新读取状态，仍失败时请管理员核查服务。"); return;
    }
    setIdentities(response.body.identities);
    setState("ready");
    await Promise.all([refreshCurrentUser(), refreshRuntimeVersion()]);
    }catch{setState("locked");setIdentities([]);setError("验收控制状态尚未读取，请重新读取状态；网络故障不表示凭证已失效。");}
  }, [refreshCurrentUser, refreshRuntimeVersion]);

  useEffect(() => { void refreshControl(); }, [refreshControl]);

  const begin = async () => {
    if (!code.trim()) return;
    setError("");
    const response = await jsonRequest<{ error?: { message?: string } }>("acceptance/control/start", {
      method: "POST", body: JSON.stringify({ code: code.trim() }),
    });
    if (response.status !== 200) {
      setError(response.body?.error?.message ?? "验收控制凭证无效或已过期。"); return;
    }
    setCode("");
    await refreshControl();
  };

  const switchIdentity = async (alias: string) => {
    if (scenarioDraft) {
      setError("当前有待保存的场景证据，请先保存或取消记录后再切换身份。");
      return;
    }
    setBusyAlias(alias); setError("");
    try {
      const response = await jsonRequest<{ user?: AuthorizedUser; error?: { message?: string } }>("acceptance/control/switch", {
        method: "POST", body: JSON.stringify({ alias }),
      });
      if (response.status !== 200) {
        setError(response.body?.error?.message ?? "切换验收身份失败。");
        if (response.status === 401) setState("locked");
        return;
      }
      setCurrentUser(response.body?.user ?? null);
      if (!response.body?.user) await refreshCurrentUser();
    } finally {
      setBusyAlias("");
    }
  };

  const runMatrix = async () => {
    if (scenarioDraft) {
      setError("当前有待保存的场景证据，请先保存或取消记录后再运行权限矩阵。");
      return;
    }
    setMatrixRunning(true); setMatrixResults([]); setError("");
    const attemptVersion = await captureRuntimeVersion();
    const startedAt = new Date().toISOString();
    const results: MatrixSummary[] = [];
    try {
      for (let index = 0; index < ACCEPTANCE_ROLE_MATRIX.length; index += 1) {
        const expectation = ACCEPTANCE_ROLE_MATRIX[index]!;
        const requests: AcceptanceRequestEvidence[] = [];
        setMatrixProgress(`${index + 1}/${ACCEPTANCE_ROLE_MATRIX.length} · ${expectation.alias}`);
        const identity = identities.find((candidate) => candidate.alias === expectation.alias);
        if (!identity) {
          results.push({ alias: expectation.alias, requests, checks: [{
            key: `${expectation.alias}:identity-missing`, category: "identity", label: "标准验收身份",
            expected: "存在", actual: "缺失", verdict: "fail",
            ruleId: "ACCEPTANCE-INFRASTRUCTURE", ruleStatus: "infrastructure",
          }] });
          continue;
        }
        const switched = await jsonRequest<{ user?: AuthorizedUser; error?: { message?: string } }>("acceptance/control/switch", {
          method: "POST", body: JSON.stringify({ alias: expectation.alias }),
        });
        requests.push({ method: "POST", path: "acceptance/control/switch", expectedStatus: 200, actualStatus: switched.status });
        if (switched.status !== 200) {
          results.push({ alias: expectation.alias, requests, checks: [evaluateHttpProbe(expectation.alias, {
            id: "switch", label: "切换真实业务 Session", path: "acceptance/control/switch", expectedStatus: 200,
            infrastructure: true,
          }, switched.status)] });
          if (switched.status === 401) throw new Error("验收控制会话已失效，请重新取得控制凭证。");
          continue;
        }
        const me = await jsonRequest<{ user?: AuthorizedUser }>("auth/me");
        requests.push({ method: "GET", path: "auth/me", expectedStatus: 200, actualStatus: me.status });
        if (me.status !== 200 || !me.body?.user) {
          results.push({ alias: expectation.alias, requests, checks: [evaluateHttpProbe(expectation.alias, {
            id: "auth-me", label: "真实业务 Session", path: "auth/me", expectedStatus: 200,
            infrastructure: true,
          }, me.status)] });
          continue;
        }
        const checks = evaluateAcceptanceSnapshot(expectation, identity, me.body.user);
        for (const probe of expectation.probes ?? []) {
          const response = await fetch(apiUrl(probe.path), { credentials: "include", cache: "no-store" });
          requests.push({ method: "GET", path: probe.path, expectedStatus: probe.expectedStatus, actualStatus: response.status });
          checks.push(evaluateHttpProbe(expectation, probe, response.status));
        }
        results.push({ alias: expectation.alias, checks, requests });
        setMatrixResults([...results]);
        setCurrentUser(me.body.user);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "权限矩阵执行失败。");
    } finally {
      const completedAt = new Date().toISOString();
      setMatrixResults([...results]); setMatrixRunning(false); setMatrixProgress("");
      updateEvidence((report) => appendMatrixEvidence(report, {
        startedAt,
        completedAt,
        version: attemptVersion,
        results,
      }));
    }
  };

  const startScenario = async (scenarioId: string) => {
    if (scenarioDraft) {
      setError("当前有待保存的场景证据，请先保存或取消记录后再开始其他场景。");
      return;
    }
    const scenario = ACCEPTANCE_SCENARIOS.find((candidate) => candidate.id === scenarioId);
    if (!scenario) return;
    setScenarioRunning(scenarioId); setError("");
    const opened = window.open("about:blank", "_blank");
    const attemptVersion = await captureRuntimeVersion();
    try {
      const switched = await jsonRequest<{ user?: AuthorizedUser; error?: { message?: string } }>("acceptance/control/switch", {
        method: "POST", body: JSON.stringify({ alias: scenario.alias }),
      });
      if (switched.status !== 200 || !switched.body?.user) {
        opened?.close();
        setError(switched.body?.error?.message ?? `无法切换到 ${scenario.alias}。`);
        return;
      }
      setCurrentUser(switched.body.user);
      const response = await fetch(apiUrl(scenario.preflight.path), { credentials: "include", cache: "no-store" });
      const preflight: AcceptanceRequestEvidence = {
        method: "GET",
        path: scenario.preflight.path,
        expectedStatus: scenario.preflight.expectedStatus,
        actualStatus: response.status,
      };
      const preflightPassed = preflight.actualStatus === preflight.expectedStatus;
      const actual = `预检 ${scenario.preflight.path}: HTTP ${response.status}（预期 ${scenario.preflight.expectedStatus}）`;
      setScenarioDraft({
        scenarioId,
        status: preflightPassed ? "not_run" : "fail",
        actual,
        preflight,
        version: attemptVersion,
      });
      if (opened) opened.location.href = pageUrl(scenario.route);
    } catch (cause) {
      opened?.close();
      const message = cause instanceof Error ? cause.message : "网络请求失败";
      setError(`场景启动或只读预检连接失败：${message}`);
      setScenarioDraft({
        scenarioId,
        status: "blocked",
        actual: `场景启动/预检传输失败：${message}`,
        preflight: {
          method: "GET",
          path: scenario.preflight.path,
          expectedStatus: scenario.preflight.expectedStatus,
          actualStatus: PREFLIGHT_TRANSPORT_FAILURE_STATUS,
        },
        version: attemptVersion,
      });
    } finally {
      setScenarioRunning("");
    }
  };

  const recordScenario = () => {
    if (!scenarioDraft) return;
    const scenario = ACCEPTANCE_SCENARIOS.find((candidate) => candidate.id === scenarioDraft.scenarioId);
    if (!scenario) return;
    const preflightTransportBlocked = scenarioDraft.preflight.actualStatus === PREFLIGHT_TRANSPORT_FAILURE_STATUS;
    const preflightPassed = scenarioDraft.preflight.actualStatus === scenarioDraft.preflight.expectedStatus;
    const saved = updateEvidence((report) => appendScenarioEvidence(report, {
      scenarioId: scenario.id,
      alias: scenario.alias,
      status: preflightTransportBlocked ? "blocked" : preflightPassed ? scenarioDraft.status : "fail",
      actual: scenarioDraft.actual.trim(),
      recordedAt: new Date().toISOString(),
      version: scenarioDraft.version,
      preflight: scenarioDraft.preflight,
    }));
    if (saved) setScenarioDraft(null);
  };

  const exportEvidence = () => {
    const safeReport = sanitizeAcceptanceEvidenceReport(evidenceReport);
    const blob = new Blob([JSON.stringify(safeReport, null, 2)], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${safeReport.reportId}.json`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  };

  const end = async () => {
    if (scenarioDraft) {
      setError("当前有待保存的场景证据，请先保存或取消记录后再结束验收。");
      return;
    }
    setError("");
    const response = await fetch(apiUrl("acceptance/control/end"), {
      method: "POST", credentials: "include", cache: "no-store",
    });
    if (response.status !== 204) { setError("结束验收失败，请刷新后重试。"); return; }
    setCurrentUser(null); setIdentities([]); setMatrixResults([]); setScenarioDraft(null); setState("locked");
  };

  const currentTarget = useMemo(() => currentUser ? platformLandingTarget(currentUser) : null, [currentUser]);
  const matrixTotals = useMemo(() => {
    const checks = matrixResults.flatMap((result) => result.checks);
    return {
      total: checks.length,
      passed: checks.filter((entry) => entry.verdict === "pass").length,
      failed: checks.filter((entry) => entry.verdict === "fail").length,
      pending: checks.filter((entry) => entry.verdict === "pending").length,
    };
  }, [matrixResults]);
  const evidenceSummary = useMemo(() => acceptanceEvidenceSummary(evidenceReport), [evidenceReport]);
  const scenarioPreflightBlocked = scenarioDraft?.preflight.actualStatus === PREFLIGHT_TRANSPORT_FAILURE_STATUS;
  const scenarioPreflightPassed = scenarioDraft
    ? !scenarioPreflightBlocked && scenarioDraft.preflight.actualStatus === scenarioDraft.preflight.expectedStatus
    : true;

  if (state === "loading") return <main className="acceptance-lab"><Surface><p role="status">正在检查隔离验收中心…</p></Surface></main>;
  if (state === "unavailable") return <main className="acceptance-lab"><Surface><h1>隔离验收中心未启用</h1><p>此入口只在明确启用 Acceptance Lab 的测试环境提供，正式环境不会注册控制接口。</p></Surface></main>;

  if (state === "locked") return <main className="acceptance-lab"><Surface className="acceptance-control-card">{error&&<Button onClick={()=>void refreshControl()}>仅重新读取验收状态</Button>}
    <StatusBadge tone="info">隔离验收中心</StatusBadge>
    <h1>取得验收控制权限</h1>
    <p>控制权限与被测业务身份相互独立。使用一次性控制凭证后，可自行切换不同测试角色。</p>
    <label>一次性控制凭证<textarea value={code} onChange={event => setCode(event.target.value)} rows={4} autoComplete="off" /></label>
    {error ? <p role="alert">{error}</p> : null}
    <Button onClick={() => void begin()} disabled={!code.trim()}>进入验收中心</Button>
  </Surface></main>;

  return <main className="acceptance-lab">
    <header className="acceptance-lab__header">
      <div><StatusBadge tone="success">Acceptance Lab 已隔离</StatusBadge><h1>角色权限验收中心</h1><p>每次切换都会建立对应合成用户的真实业务 Session，不继承操作者 Root 权限。</p></div>
      <Button variant="secondary" onClick={() => void end()} disabled={matrixRunning || Boolean(scenarioRunning) || Boolean(scenarioDraft)}>结束验收</Button>
    </header>
    {error ? <p role="alert" className="acceptance-lab__error">{error}</p> : null}

    <Surface className="acceptance-evidence-panel">
      <div className="acceptance-evidence-heading"><div><h2>验收证据报告</h2><p>矩阵重跑和场景复测只追加新 attempt，不覆盖历史失败；持久化和导出边界会自动清理 Cookie、Token、控制凭证和 Session 形态的敏感值。</p></div><Button variant="secondary" onClick={exportEvidence}>导出 JSON 报告</Button></div>
      <div className="acceptance-evidence-meta"><span>报告：{evidenceReport.reportId}</span><span>矩阵运行：{evidenceReport.matrixAttempts.length} 次</span><span>历史场景失败：{evidenceSummary.historicalFailures}</span>{runtimeVersion ? <><span>Git：{runtimeVersion.gitSha.slice(0, 12)}</span><span>Schema：{runtimeVersion.schemaVersion ?? "未知"}</span></> : <span>{runtimeReadFailed?"版本信息尚未读取，请仅重读运行版本":"正在读取版本信息"}</span>}</div>
      <div className="acceptance-evidence-summary"><strong>最新矩阵 {evidenceSummary.matrixPassed} 通过 · {evidenceSummary.matrixFailed} 失败 · {evidenceSummary.matrixPending} 标准待确认 / 共 {evidenceSummary.matrixTotal}</strong><span>场景：{evidenceSummary.scenarios.pass} 通过 · {evidenceSummary.scenarios.fail} 失败 · {evidenceSummary.scenarios.blocked} 受阻 · {evidenceSummary.scenarios.notRun} 未执行</span></div>
    </Surface>

    <Surface className="acceptance-matrix-panel">
      <div><h2>自动权限矩阵</h2><p>机器只允许有 APPROVED Golden Source 的业务规则判通过/失败；PENDING 或尚未绑定来源的检查仍记录实际结果，但只显示“标准待确认”，不会被当成权限缺陷。</p></div>
      <Button onClick={() => void runMatrix()} disabled={matrixRunning || Boolean(scenarioRunning) || Boolean(scenarioDraft) || identities.length === 0}>{matrixRunning ? `执行中 ${matrixProgress}` : "运行全部角色权限矩阵"}</Button>
      {matrixTotals.total > 0 ? <div className="acceptance-matrix-summary"><strong>{matrixTotals.passed} 通过 · {matrixTotals.failed} 失败</strong><span>{matrixTotals.pending} 项标准待确认 · 共 {matrixTotals.total} 项</span></div> : null}
      {matrixResults.length > 0 ? <div className="acceptance-matrix-results">
        {matrixResults.map((result) => {
          const failed = result.checks.filter((entry) => entry.verdict === "fail");
          const pending = result.checks.filter((entry) => entry.verdict === "pending");
          const summary = failed.length > 0
            ? `${failed.length} 项不一致`
            : pending.length > 0 ? `${pending.length} 项标准待确认` : "通过";
          return <details key={result.alias} open={failed.length > 0 || pending.length > 0}><summary><strong>{result.alias}</strong><span>{summary}</span></summary>
            <div className="acceptance-matrix-checks">{result.checks.map((entry) => <div className={`acceptance-matrix-check is-${entry.verdict}`} key={entry.key}><span>{entry.label}</span><small>预期：{entry.expected} · 实际：{entry.actual}</small><small>规则：{ruleStatusLabel(entry)}</small></div>)}</div>
          </details>;
        })}
      </div> : null}
    </Surface>

    <Surface className="acceptance-scenario-panel">
      <div><h2>代表性浏览器与业务场景</h2><p>这里不模拟点击。系统先切换真实 UAT 身份并做只读预检，再用新窗口进入正式业务页面；验收人按正常点击完成步骤并记录结果。</p></div>
      <div className="acceptance-scenarios">
        {ACCEPTANCE_SCENARIOS.map((scenario) => {
          const latest = latestScenarioEvidence(evidenceReport, scenario.id);
          const firstFailure = firstFailureForScenario(evidenceReport, scenario.id);
          return <article className="acceptance-scenario" key={scenario.id}>
            <div><strong>{scenario.title}</strong><small>{scenario.alias} · {scenario.kind}</small></div>
            <p>{scenario.expected}</p>
            <ol>{scenario.steps.map((step) => <li key={step}>{step}</li>)}</ol>
            <div className="acceptance-scenario-meta"><span>预检：GET {scenario.preflight.path} → 预期 HTTP {scenario.preflight.expectedStatus}</span><span>最新：{latest ? statusLabels[latest.status] : "未执行"}</span>{firstFailure ? <span>首次失败仍保留：{firstFailure.recordedAt}</span> : null}</div>
            <Button variant="secondary" onClick={() => void startScenario(scenario.id)} disabled={matrixRunning || Boolean(scenarioRunning) || Boolean(scenarioDraft)}>{scenarioRunning === scenario.id ? "正在切换身份…" : "开始场景并打开业务页"}</Button>
          </article>;
        })}
      </div>
      {scenarioDraft ? <div className="acceptance-scenario-recorder">
        <h3>记录：{ACCEPTANCE_SCENARIOS.find((scenario) => scenario.id === scenarioDraft.scenarioId)?.title}</h3>
        <p>只读预检：GET {scenarioDraft.preflight.path} → {scenarioPreflightBlocked ? "传输失败" : `HTTP ${scenarioDraft.preflight.actualStatus}`}（预期 {scenarioDraft.preflight.expectedStatus}）</p>
        {scenarioPreflightBlocked
          ? <p role="alert">只读预检发生传输失败，本次场景只能记录为受阻。</p>
          : !scenarioPreflightPassed
            ? <p role="alert">只读预检未达到批准预期，本次场景不能记录为通过，保存时会强制记为失败。</p>
            : null}
        <label>结果<select value={scenarioDraft.status} onChange={(event) => setScenarioDraft({ ...scenarioDraft, status: event.target.value as AcceptanceEvidenceStatus })}><option value="not_run" disabled={scenarioPreflightBlocked}>未执行</option><option value="pass" disabled={!scenarioPreflightPassed}>通过</option><option value="fail" disabled={scenarioPreflightBlocked}>失败</option><option value="blocked">受阻</option></select></label>
        <label>实际结果 / 数据或待办变化<textarea value={scenarioDraft.actual} onChange={(event) => setScenarioDraft({ ...scenarioDraft, actual: event.target.value })} placeholder="记录实际看到的页面、按钮、请求结果以及数据/待办变化；敏感形态会在保存和导出边界自动清理。" rows={4} /></label>
        <div><Button onClick={recordScenario}>保存本次证据</Button><Button variant="secondary" onClick={() => setScenarioDraft(null)}>取消记录</Button></div>
      </div> : null}
    </Surface>

    <Surface className="acceptance-current">
      <h2>当前被测身份</h2>
      {currentUser ? <div><strong>{currentUser.displayName}</strong><span>{currentUser.isRoot ? "Root" : currentUser.businessRoles?.map(role => roleLabels[role] ?? role).join(" / ") || "无业务角色"}</span>
        {currentTarget ? <a className="acceptance-open-business" href={pageUrl(currentTarget)} target="_blank" rel="noreferrer">新窗口打开当前身份业务页</a> : null}
      </div> : <p>尚未选择被测身份。</p>}
    </Surface>
    <section className="acceptance-identities" aria-label="标准验收身份">
      {identities.map(identity => <Surface className="acceptance-identity" key={identity.userId}>
        <div><strong>{identity.displayName}</strong><small>{identity.roleCodes.map(role => roleLabels[role] ?? role).join(" / ") || "未分配角色"}</small></div>
        <div className="acceptance-identity__meta"><span>{identity.alias}</span><span>{identity.capabilities.length} 项 capability</span></div>
        <Button onClick={() => void switchIdentity(identity.alias)} disabled={!identity.active || !identity.employed || Boolean(busyAlias) || matrixRunning || Boolean(scenarioRunning) || Boolean(scenarioDraft)}>{busyAlias === identity.alias ? "切换中…" : "切换到此身份"}</Button>
      </Surface>)}
    </section>
  </main>;
}
