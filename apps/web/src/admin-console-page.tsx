import { useEffect, useState, type ReactNode } from "react";
import { Button, Surface } from "@dx-rework/ui";
import type { AdminAuditEventsPage, AdminAuditExportsPage } from "@dx-rework/contracts";
import type { AdminAttachmentsPage, AdminDelegationsPage, AdminExceptionsPage } from "@dx-rework/contracts/admin-console";
import { createWebUrls } from "../url-contract.js";
import type { AuthorizedUser } from "./auth.js";
import { CursorListPagination, ListPagination, usePaginatedItems } from "./list-pagination.js";
import { SystemManagementNavigation, type SystemManagementTechnicalTab } from "./system-management-navigation.js";
import {
  businessActionLabel,
  businessCapabilityLabel,
  businessEntityLabel,
  businessExceptionLabel,
  businessFieldLabel,
  businessRoleLabel,
  businessValue,
  formatBusinessTime,
  formatFileSize,
  translateTechnicalDetails,
} from "./business-display.js";
import "./admin-console.css";

const { apiUrl, pageUrl } = createWebUrls(import.meta.env.BASE_URL);
type Tab = SystemManagementTechnicalTab;
type LoadError = { kind: "error"; message: string; requestId: string | null };
type LoadState<T> = { kind: "loading" } | LoadError | { kind: "ready"; data: T };

class AdminRequestError extends Error {
  constructor(message: string, readonly requestId: string | null) {
    super(message);
    this.name = "AdminRequestError";
  }
}

const loadError = (error: unknown): LoadError => ({
  kind: "error",
  message: error instanceof Error ? error.message : "加载失败",
  requestId: error instanceof AdminRequestError ? error.requestId : null,
});

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(apiUrl(path), { credentials: "include", headers: { accept: "application/json" } });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: { message?: string; requestId?: string } } | null;
    throw new AdminRequestError(
      body?.error?.message ?? `请求失败：${response.status}`,
      body?.error?.requestId ?? response.headers.get("x-request-id"),
    );
  }
  return await response.json() as T;
}

function CopyableRequestId({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (!navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return <span>请求 ID：<code>{value}</code> <Button onClick={() => void copy()}>{copied ? "已复制" : "复制请求 ID"}</Button></span>;
}

function JsonDetails({ value }: { value: unknown }) {
  return <details><summary>查看详情</summary><pre>{JSON.stringify(translateTechnicalDetails(value), null, 2)}</pre></details>;
}

export function AdminConsolePage({ initialTab = "audit" }: { initialTab?: Tab }) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [technicalAccess, setTechnicalAccess] = useState<boolean | null>(null);

  useEffect(() => { setTab(initialTab); }, [initialTab]);

  useEffect(() => {
    let mounted = true;
    void fetch(apiUrl("auth/me"), { credentials: "include", cache: "no-store" })
      .then(async (response) => response.ok ? await response.json() as { status: string; user?: AuthorizedUser } : null)
      .then((body) => {
        if (!mounted) return;
        const user = body?.status === "authorized" ? body.user : undefined;
        const allowed = user?.isRoot === true || (
          user?.businessRoles?.includes("system_admin") === true
          && user.capabilities.includes("admin:read")
        );
        setTechnicalAccess(allowed);
        if (!allowed) setTab("audit");
      })
      .catch(() => {
        if (mounted) setTechnicalAccess(false);
      });
    return () => { mounted = false; };
  }, []);

  return (
    <div className="admin-shell">
      <header className="page-heading">
        <div>
          <h1>系统管理</h1>
          <p>维护人员访问、系统资料与可追溯的运行记录。</p>
        </div>
      </header>
      <Surface className="admin-card">
        <SystemManagementNavigation active={tab} onTechnicalTabChange={setTab} />
        {technicalAccess === null ? <p>正在加载管理权限…</p> : (
          <>
            {tab === "audit" ? <AuditTab /> : tab === "attachments" ? <AttachmentsTab /> : tab === "delegations" ? <DelegationsTab /> : <ExceptionsTab />}
          </>
        )}
      </Surface>
    </div>
  );
}

function AuditTab() {
  const [cursor, setCursor] = useState<string | undefined>();
  const [cursorHistory, setCursorHistory] = useState<readonly string[]>([]);
  const [searchVersion, setSearchVersion] = useState(0);
  const [state, setState] = useState<LoadState<{ events: AdminAuditEventsPage; exports: AdminAuditExportsPage }>>({ kind: "loading" });
  const [filters, setFilters] = useState({ from: "", to: "", actorId: "", action: "", entityType: "", entityId: "", authorizationCapability: "", requestId: "" });
  const query = () => new URLSearchParams(Object.entries({ ...filters, cursor: cursor ?? "", limit: "15" }).filter((entry): entry is [string, string] => entry[1] !== "")).toString();
  useEffect(() => {
    setState({ kind: "loading" });
    void Promise.all([
      getJson<AdminAuditEventsPage>(`admin/audit/events?${query()}`),
      getJson<AdminAuditExportsPage>("admin/audit/exports?limit=10"),
    ])
      .then(([events, exports]) => setState({ kind: "ready", data: { events, exports } }))
      .catch((error: unknown) => setState(loadError(error)));
  }, [cursor, searchVersion]);
  const submitSearch = () => {
    setCursor(undefined);
    setCursorHistory([]);
    setSearchVersion((value) => value + 1);
  };
  return (
    <section className="admin-panel">
      <FilterGrid filters={filters} setFilters={setFilters} onSearch={submitSearch} />
      <State state={state} render={({ events, exports }) => (
        <>
          <div className="admin-list">
            {events.items.length === 0 ? <p>暂无审计日志。</p> : events.items.map((event) => (
              <article key={event.eventId}>
                <h3>{businessActionLabel(event.action)}</h3>
                <p>{event.actorDisplayName ?? "未知操作人"} · {formatBusinessTime(event.createdAt)}</p>
                <p>{businessEntityLabel(event.entityType)} / {event.entityId}</p>
                <p>权限：{businessCapabilityLabel(event.authorizationCapability)} · 请求：{event.requestId}</p>
                <p>历史角色：{event.actorRoles.map(businessRoleLabel).join("、") || "未记录"}</p>
                <JsonDetails value={{ beforeState: event.beforeState, afterState: event.afterState, reason: event.reason }} />
              </article>
            ))}
          </div>
          <CursorListPagination
            page={cursorHistory.length + 1}
            canGoPrevious={cursorHistory.length > 0}
            canGoNext={Boolean(events.nextCursor)}
            ariaLabel="审计日志分页"
            onPrevious={() => {
              setCursor(cursorHistory[cursorHistory.length - 1] || undefined);
              setCursorHistory((history) => history.slice(0, -1));
            }}
            onNext={() => {
              if (!events.nextCursor) return;
              setCursorHistory((history) => [...history, cursor ?? ""]);
              setCursor(events.nextCursor);
            }}
          />
          <h2>导出记录</h2>
          {exports.items.map((item) => <article key={item.eventId}><b>{businessActionLabel(item.action)}</b><p>{businessValue("reportType", item.exportType ?? item.reportType ?? "未知导出类型")} · {formatBusinessTime(item.createdAt)}</p></article>)}
        </>
      )} />
    </section>
  );
}

function FilterGrid<T extends Record<string, string>>({ filters, setFilters, onSearch }: { filters: T; setFilters: (value: T) => void; onSearch: () => void }) {
  return (
    <div className="admin-filter-grid">
      {Object.keys(filters).map((key) => (
        <label key={key}>{businessFieldLabel(key)}<input value={filters[key]} onChange={(event) => setFilters({ ...filters, [key]: event.target.value })} /></label>
      ))}
      <Button onClick={onSearch}>查询</Button>
    </div>
  );
}

function State<T>({ state, render }: { state: LoadState<T>; render: (value: T) => ReactNode }) {
  if (state.kind === "loading") return <p>加载中…</p>;
  if (state.kind === "error") return <div className="admin-error" role="alert"><p>{state.message}</p>{state.requestId ? <CopyableRequestId value={state.requestId} /> : null}</div>;
  return render(state.data);
}

const attachmentStatusLabel: Record<"pending" | "ready" | "rejected", string> = {
  pending: "待上传（尚未完成）",
  ready: "已上传",
  rejected: "已拒绝",
};

function AttachmentsTab() {
  const [cursor, setCursor] = useState<string | undefined>();
  const [cursorHistory, setCursorHistory] = useState<readonly string[]>([]);
  const [state, setState] = useState<LoadState<AdminAttachmentsPage>>({ kind: "loading" });
  useEffect(() => {
    setState({ kind: "loading" });
    void getJson<AdminAttachmentsPage>(`admin/attachments?limit=15${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`)
      .then((data) => setState({ kind: "ready", data }))
      .catch((error: unknown) => setState(loadError(error)));
  }, [cursor]);
  return (
    <section className="admin-panel">
      <State state={state} render={(data) => <><div className="admin-table">{data.items.length === 0 ? <p>暂无附件。</p> : data.items.map((item) => <article key={item.attachmentId}><h3>{item.filename}</h3><p>{attachmentStatusLabel[item.status]} · {businessValue("mimeType", item.mimeType)} · {formatFileSize(item.sizeBytes)}</p><p>{item.uploaderDisplayName ?? "未知上传人"} · {item.uploadedBy}</p><p>{item.entityType ? businessEntityLabel(item.entityType) : "未绑定"} / {item.entityId ?? "—"}</p><p>SHA-256：{item.sha256}</p><p>{item.rejectionReason ?? "无驳回原因"}</p><Button onClick={() => window.open(apiUrl(`tools/attachments/${item.attachmentId}/download`), "_blank")}>按既有授权申请下载</Button></article>)}</div><CursorListPagination page={cursorHistory.length + 1} canGoPrevious={cursorHistory.length > 0} canGoNext={Boolean(data.nextCursor)} ariaLabel="附件分页" onPrevious={() => { setCursor(cursorHistory[cursorHistory.length - 1] || undefined); setCursorHistory((history) => history.slice(0, -1)); }} onNext={() => { if (!data.nextCursor) return; setCursorHistory((history) => [...history, cursor ?? ""]); setCursor(data.nextCursor); }} /></>} />
    </section>
  );
}

function DelegationsTab() {
  const [state, setState] = useState<LoadState<AdminDelegationsPage>>({ kind: "loading" });
  useEffect(() => {
    void getJson<AdminDelegationsPage>("admin/delegations?includeRevoked=true&limit=50")
      .then((data) => setState({ kind: "ready", data }))
      .catch((error: unknown) => setState(loadError(error)));
  }, []);
  return <section className="admin-panel"><State state={state} render={(data) => <DelegationList data={data} />} /></section>;
}

function DelegationList({ data }: { data: AdminDelegationsPage }) {
  const page = usePaginatedItems(data.items, "delegations");
  return <><div className="admin-list">{data.items.length === 0 ? <p>暂无代理授权。</p> : page.items.map((item) => <article key={item.delegationId}><h3>{businessCapabilityLabel(item.capability)}</h3><p>授权人：{item.grantor.displayName ?? "未知"}（{item.grantor.userId}） → 被授权人：{item.grantee.displayName ?? "未知"}（{item.grantee.userId}）</p><p>授权范围：{businessValue("scopeType", item.scopeType)} / {item.scopeId ?? "全局"}</p><p>{item.effectiveNow ? "当前有效" : "当前无效"} · {formatBusinessTime(item.validFrom)} 至 {formatBusinessTime(item.validUntil)}</p><p>{item.revokedAt ? `已撤销：${item.revokeReason ?? "未记录"}` : item.grantReason}</p></article>)}</div><ListPagination page={page.page} totalPages={page.totalPages} onPageChange={page.setPage} ariaLabel="代理授权分页" /></>;
}

function ExceptionsTab() {
  const [state, setState] = useState<LoadState<AdminExceptionsPage>>({ kind: "loading" });
  useEffect(() => {
    void getJson<AdminExceptionsPage>("admin/exceptions?limit=50")
      .then((data) => setState({ kind: "ready", data }))
      .catch((error: unknown) => setState(loadError(error)));
  }, []);
  return <section className="admin-panel"><State state={state} render={(data) => <ExceptionList data={data} />} /></section>;
}

function ExceptionList({ data }: { data: AdminExceptionsPage }) {
  const page = usePaginatedItems(data.items, "exceptions");
  return <><div className="admin-list">{data.items.length === 0 ? <p>暂无系统异常。</p> : page.items.map((item) => <article key={`${item.exceptionType}:${item.sourceEntityId}`}><h3>{businessExceptionLabel(item.exceptionType)}</h3><p>{businessEntityLabel(item.sourceEntityType)} / {item.sourceEntityId}</p><p>关联订单：{item.reworkOrderId && item.deepLink ? <a href={pageUrl(item.deepLink)}>{item.reworkOrderId} · 进入返工单</a> : "未关联返工单"}</p><p>业务动作：{item.businessAction} · 失败阶段：{item.failureStage}</p><p>处理状态：{businessValue("status", item.status)} · 最近更新：{formatBusinessTime(item.lastUpdatedAt)}</p><p>最近错误：{item.safeError ?? "无安全错误摘要"}</p>{item.requestId ? <p><CopyableRequestId value={item.requestId} /></p> : <p>请求 ID：未记录</p>}<p>{item.retryable ? "可安全重试" : "不可由管理员重试"}</p><JsonDetails value={item.details} /></article>)}</div><ListPagination page={page.page} totalPages={page.totalPages} onPageChange={page.setPage} ariaLabel="系统异常分页" /></>;
}
