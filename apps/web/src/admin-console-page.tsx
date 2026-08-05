import { useEffect, useState, type ReactNode } from "react";
import { Button, Surface } from "@dx-rework/ui";
import type { AdminAuditEventsPage, AdminAuditExportsPage } from "@dx-rework/contracts";
import type { AdminAttachmentsPage, AdminDelegationsPage, AdminExceptionsPage } from "@dx-rework/contracts/admin-console";
import { createWebUrls } from "../url-contract.js";
import "./admin-console.css";

const { apiUrl } = createWebUrls(import.meta.env.BASE_URL);
type Tab = "audit" | "attachments" | "delegations" | "exceptions";
type LoadState<T> = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; data: T };
const tabs: readonly [Tab, string][] = [["audit", "审计日志"], ["attachments", "附件管理"], ["delegations", "代理授权"], ["exceptions", "系统异常"]];

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(apiUrl(path), { credentials: "include", headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`请求失败：${response.status}`);
  return await response.json() as T;
}

function JsonDetails({ value }: { value: unknown }) { return <details><summary>查看 JSON 详情</summary><pre>{JSON.stringify(value, null, 2)}</pre></details>; }
function Pager({ cursor, onNext }: { cursor: string | null; onNext: (cursor: string) => void }) { return <div className="admin-pager">{cursor ? <Button onClick={() => onNext(cursor)}>下一页</Button> : <span>没有更多数据</span>}</div>; }

export function AdminConsolePage() {
  const [tab, setTab] = useState<Tab>("audit");
  return <main className="admin-shell"><Surface className="admin-card"><p className="eyebrow">PR-15 · 管理员后台</p><h1>系统管理员控制台</h1><p className="admin-retention">一期数据默认长期保留，当前未启用自动删除。</p><nav className="admin-tabs" aria-label="管理员后台页签">{tabs.map(([value, label]) => <button key={value} className={tab === value ? "active" : ""} onClick={() => setTab(value)}>{label}</button>)}</nav>{tab === "audit" ? <AuditTab /> : tab === "attachments" ? <AttachmentsTab /> : tab === "delegations" ? <DelegationsTab /> : <ExceptionsTab />}</Surface></main>;
}

function AuditTab() {
  const [cursor, setCursor] = useState<string | undefined>();
  const [searchVersion, setSearchVersion] = useState(0);
  const [state, setState] = useState<LoadState<{ events: AdminAuditEventsPage; exports: AdminAuditExportsPage }>>({ kind: "loading" });
  const [filters, setFilters] = useState({ from: "", to: "", actorId: "", action: "", entityType: "", entityId: "", authorizationCapability: "", requestId: "" });
  const query = () => new URLSearchParams(Object.entries({ ...filters, cursor: cursor ?? "", limit: "20" }).filter((entry): entry is [string, string] => entry[1] !== "")).toString();
  useEffect(() => {
    setState({ kind: "loading" });
    void Promise.all([getJson<AdminAuditEventsPage>(`admin/audit/events?${query()}`), getJson<AdminAuditExportsPage>(`admin/audit/exports?limit=10`)])
      .then(([events, exports]) => setState({ kind: "ready", data: { events, exports } }))
      .catch((error: unknown) => setState({ kind: "error", message: error instanceof Error ? error.message : "加载失败" }));
  }, [cursor, searchVersion]);
  const submitSearch = () => {
    setCursor(undefined);
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
                <h3>{event.action}</h3>
                <p>{event.actorDisplayName ?? "未知操作人"} · {event.actorId}</p>
                <p>{event.entityType} / {event.entityId}</p>
                <p>权限：{event.authorizationCapability} · 请求：{event.requestId}</p>
                <p>历史角色：{event.actorRoles.join(", ")}</p>
                <JsonDetails value={{ beforeState: event.beforeState, afterState: event.afterState, reason: event.reason }} />
              </article>
            ))}
          </div>
          <Pager cursor={events.nextCursor} onNext={setCursor} />
          <h2>导出审计</h2>
          {exports.items.map((item) => <article key={item.eventId}><b>{item.action}</b><p>{item.exportType ?? item.reportType ?? "未知导出类型"} · {item.createdAt}</p></article>)}
        </>
      )} />
    </section>
  );
}

function FilterGrid<T extends Record<string, string>>({ filters, setFilters, onSearch }: { filters: T; setFilters: (value: T) => void; onSearch: () => void }) { return <div className="admin-filter-grid">{Object.keys(filters).map((key) => <label key={key}>{key}<input value={filters[key]} onChange={(event) => setFilters({ ...filters, [key]: event.target.value })} /></label>)}<Button onClick={onSearch}>查询</Button></div>; }
function State<T>({ state, render }: { state: LoadState<T>; render: (value: T) => ReactNode }) { if (state.kind === "loading") return <p>加载中…</p>; if (state.kind === "error") return <p className="admin-error">{state.message}</p>; return render(state.data); }

function AttachmentsTab() { const [cursor, setCursor] = useState<string | undefined>(); const [state, setState] = useState<LoadState<AdminAttachmentsPage>>({ kind: "loading" }); useEffect(() => { setState({ kind: "loading" }); void getJson<AdminAttachmentsPage>(`admin/attachments?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`).then((data) => setState({ kind: "ready", data })).catch((error: unknown) => setState({ kind: "error", message: error instanceof Error ? error.message : "加载失败" })); }, [cursor]); return <section className="admin-panel"><p>管理员只查看附件元数据；下载请继续使用既有附件下载授权。</p><State state={state} render={(data) => <><div className="admin-table">{data.items.length === 0 ? <p>暂无附件。</p> : data.items.map((item) => <article key={item.attachmentId}><h3>{item.filename}</h3><p>{item.status} · {item.mimeType} · {item.sizeBytes} bytes</p><p>{item.uploaderDisplayName ?? "未知上传人"} · {item.uploadedBy}</p><p>{item.entityType ?? "未绑定"} / {item.entityId ?? "—"}</p><p>SHA-256：{item.sha256}</p><p>{item.rejectionReason ?? "无驳回原因"}</p><Button onClick={() => window.open(apiUrl(`tools/attachments/${item.attachmentId}/download`), "_blank")}>按既有授权申请下载</Button></article>)}</div><Pager cursor={data.nextCursor} onNext={setCursor} /></>} /></section>; }
function DelegationsTab() { const [state, setState] = useState<LoadState<AdminDelegationsPage>>({ kind: "loading" }); useEffect(() => { void getJson<AdminDelegationsPage>("admin/delegations?includeRevoked=true&limit=50").then((data) => setState({ kind: "ready", data })).catch((error: unknown) => setState({ kind: "error", message: error instanceof Error ? error.message : "加载失败" })); }, []); return <section className="admin-panel"><State state={state} render={(data) => <div className="admin-list">{data.items.length === 0 ? <p>暂无代理授权。</p> : data.items.map((item) => <article key={item.delegationId}><h3>{item.capability}</h3><p>{item.grantor.displayName ?? "grantor"}({item.grantor.userId}) → {item.grantee.displayName ?? "grantee"}({item.grantee.userId})</p><p>{item.scopeType} / {item.scopeId ?? "global"}</p><p>{item.effectiveNow ? "当前有效" : "当前无效"} · {item.validFrom} - {item.validUntil}</p><p>{item.revokedAt ? `已撤销：${item.revokeReason ?? "未记录"}` : item.grantReason}</p></article>)}</div>} /></section>; }
function ExceptionsTab() { const [state, setState] = useState<LoadState<AdminExceptionsPage>>({ kind: "loading" }); useEffect(() => { void getJson<AdminExceptionsPage>("admin/exceptions?limit=50").then((data) => setState({ kind: "ready", data })).catch((error: unknown) => setState({ kind: "error", message: error instanceof Error ? error.message : "加载失败" })); }, []); return <section className="admin-panel"><State state={state} render={(data) => <div className="admin-list">{data.items.length === 0 ? <p>暂无系统异常。</p> : data.items.map((item) => <article key={`${item.exceptionType}:${item.sourceEntityId}`}><h3>{item.exceptionType}</h3><p>{item.sourceEntityType} / {item.sourceEntityId}</p><p>{item.status} · {item.occurredAt}</p><p>{item.safeError ?? "无安全错误摘要"}</p><p>{item.retryable ? "可安全重试" : "不可由管理员重试"}</p><JsonDetails value={item.details} /></article>)}</div>} /></section>; }
