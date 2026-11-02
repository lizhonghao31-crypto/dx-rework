import {supplierRequestFilters,supplierRequestListPath,supplierRequestReturnPath} from "./supplier-workspace-query.js";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button, StatusBadge, Surface } from "@dx-rework/ui";
import type { SupplierOnboardingDetail, SupplierOnboardingProfile, SupplierOnboardingStatus, SupplierOnboardingSummary } from "@dx-rework/contracts/supplier-onboarding";
import { createWebUrls } from "../url-contract.js";
import { verifySession, type AuthorizedUser } from "./auth.js";
import { Shell } from "./components.js";
import { NavigationIcon } from "./navigation-icons.js";
import { SupplierProfileForm } from "./supplier-profile-form.js";
import { emptyDraft } from "./supplier-profile-draft.js";
import { SUPPLIER_TYPE_LABELS } from "./supplier-center-model.js";
import { canApproveSupplier, canReadSupplierApplications, canRequestSupplier, supplierApplicationDraft, supplierApplicationPayload, supplierApplicationVersion, SUPPLIER_REQUEST_STATUS } from "./supplier-onboarding-model.js";
import { ListPagination, usePaginatedItems } from "./list-pagination.js";
import { createSupplierDraftGuard } from "./supplier-draft-guard.js";
import { registerInternalNavigationGuard } from "./internal-navigation.js";
import { confirmInApp } from "./system-dialog.js";
import { todoReturnPath } from "./todo-query-state.js";
import { createClientRequestId } from "./client-request-id.js";
import "./supplier-center-page.css";
import "./supplier-onboarding-page.css";
const { apiUrl, pageUrl } = createWebUrls(import.meta.env.BASE_URL);
class RequestError extends Error { constructor(message: string, readonly status: number) { super(message); } }
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(apiUrl(path), { credentials: "include", ...init, headers: { accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers } });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new RequestError(body?.error?.message ?? `请求失败：${response.status}`, response.status);
  return body as T;
}
const date = (value: string) => new Date(value).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
export function SupplierApplicationSnapshot({ profile }: { profile: SupplierOnboardingProfile }) {
  const fields: [string, string | number | null | undefined][] = [
    ["供应商名称", profile.supplierName], ["供应商类型", SUPPLIER_TYPE_LABELS[profile.supplierType]], ["联系人", profile.contactPerson], ["联系电话", profile.contactPhone],
    ["地址", profile.address], ["收款人", profile.payeeName], ["收款账号", profile.bankAccount], ["开户行", profile.bankName],
    ["合同主体名称", profile.contractEntityName], ["乙方代表", profile.partyBRepresentative], ["可承接工艺", profile.supportedCrafts.join("、")],
    ["常规日产能", profile.dailyCapacity], ["备注", profile.notes],
  ];
  const groups = [
    { title: "基础资料", fields: fields.slice(0, 5) },
    { title: "合同收款", fields: fields.slice(5, 10) },
    { title: "工艺产能", fields: fields.slice(10) },
  ];
  return <div className="supplier-profile__sections supplier-application-sections">{groups.map(group => <section key={group.title}><h3>{group.title}</h3><dl className="supplier-application-snapshot">{group.fields.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value == null || value === "" ? "—" : value}</dd></div>)}</dl></section>)}</div>;
}
export function SupplierDuplicateCheck({ check }: { check: SupplierOnboardingDetail["duplicateCheck"] }) {
  if (!check) return <p role="status">查重结果未就绪，请刷新后审批。</p>;
  const conflict = check.formalSupplierCount + check.pendingRequestCount > 0;
  return <div className={`supplier-duplicate-check ${conflict ? "supplier-return-reason" : "supplier-center-notice"}`} role="status"><strong>查重结果：{conflict ? "发现同名同类型记录" : "未发现同名同类型记录"}</strong>
    <p>正式供应商（含停用）：{check.formalSupplierCount} 条；其他待审批申请：{check.pendingRequestCount} 条。</p>
    <small>检查时间：{date(check.checkedAt)}。通过时会再次检查。</small></div>;
}
export function SupplierApplicationList({ items, reviewer, canApprove = reviewer, returnTo }: { items: readonly SupplierOnboardingSummary[]; reviewer: boolean; canApprove?: boolean; returnTo?:string }) {
  return <table className="supplier-records supplier-applications-table"><thead><tr><th>供应商</th>{reviewer ? <th>申请人</th> : null}<th>状态</th><th>更新时间</th><th>操作</th></tr></thead>
    <tbody>{items.map(item => <tr key={item.requestId}><td><strong>{item.supplierName}</strong><small>{SUPPLIER_TYPE_LABELS[item.supplierType]} · 第 {item.version} 版</small></td>
      {reviewer ? <td data-label="申请人">{item.applicantName}</td> : null}<td data-label="状态"><StatusBadge tone={item.status === "approved" ? "success" : item.status === "returned" ? "warning" : "info"}>{SUPPLIER_REQUEST_STATUS[item.status]}</StatusBadge></td>
      <td data-label="更新时间"><time dateTime={item.updatedAt}>{date(item.updatedAt)}</time></td><td className="supplier-records__action"><a href={`${pageUrl(`ui/suppliers/requests/${item.requestId}`)}${returnTo?`?${new URLSearchParams({returnTo})}`:""}`}>{canApprove && item.status === "pending_approval" ? "审批" : item.status === "returned" && !reviewer ? "查看并修改" : "查看"}</a></td></tr>)}</tbody></table>;
}
export function SupplierOnboardingPage({ requestId, user: providedUser }: { requestId?: string; user?: AuthorizedUser }) {
  const [user, setUser] = useState<AuthorizedUser | null>(providedUser ?? null);
  const [identityError, setIdentityError] = useState("");
  const [items, setItems] = useState<SupplierOnboardingSummary[]>([]), [detail, setDetail] = useState<SupplierOnboardingDetail | null>(null);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [message, setMessage] = useState(""), [reload, setReload] = useState(0), [selectedVersion, setSelectedVersion] = useState(0);
  const [draft, setDraft] = useState(emptyDraft), [editing, setEditing] = useState(false), [reason, setReason] = useState("");
  const [initialFilters]=useState(()=>({...supplierRequestFilters(window.location.search),explicitStatus:new URLSearchParams(window.location.search).has("status")}));
  const [query, setQuery] = useState(initialFilters.q), [status, setStatus] = useState<SupplierOnboardingStatus | "all">(initialFilters.status);
  useEffect(()=>{if(!requestId)window.history.replaceState(window.history.state,"",pageUrl(supplierRequestListPath(query,status)));},[query,status,requestId]);
  const lock = useRef(false), alive = useRef(true), operation = useRef<{ fingerprint: string; key: string } | null>(null);
  const creating = requestId === "new", reviewer = user ? canApproveSupplier(user) : false, reader = user ? canReadSupplierApplications(user) : false, applicant = user ? canRequestSupplier(user) : false;
  const baseDraft = detail ? supplierApplicationDraft(detail.profile) : emptyDraft();
  const dirty = (creating || editing) && JSON.stringify(draft) !== JSON.stringify(baseDraft);
  const [guard] = useState(() => createSupplierDraftGuard({ isBlocked: () => lock.current,
    confirm: () => confirmInApp("申请有未保存内容，确定放弃这些修改？", { title: "未保存修改", confirmLabel: "放弃修改", cancelLabel: "继续编辑" }),
    discard: () => { setEditing(false); setDraft(emptyDraft()); },
  }));
  guard.setDirty(dirty);
  useEffect(() => {
    alive.current = true;
    const unregister = registerInternalNavigationGuard(() => guard.requestLeave());
    const before = (event: BeforeUnloadEvent) => { if (guard.shouldBlock) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", before);
    return () => { alive.current = false; unregister(); window.removeEventListener("beforeunload", before); };
  }, [guard]);
  useEffect(() => {
    if (providedUser) return;
    let current = true;
    void verifySession().then(session => { if (current) { if (typeof session === "string") setIdentityError("身份已失效，请重新登录"); else setUser(session.user); } }).catch(e => { if (current) setIdentityError(e instanceof Error ? e.message : "身份核验失败"); });
    return () => { current = false; };
  }, [providedUser]);
  useEffect(() => { if(user&&!initialFilters.explicitStatus)setStatus(reviewer ? "pending_approval" : "all"); }, [reviewer,user,initialFilters.explicitStatus]);
  useEffect(() => {
    if (!user || (!reader && !applicant)) { setLoading(false); return; }
    const controller = new AbortController(); setError(""); setLoading(true);
    const load = async () => {
      if (creating) { setLoading(false); return; }
      if (requestId) {
        setDetail(null);
        const value = await request<SupplierOnboardingDetail>(`supplier-onboarding/requests/${requestId}`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setDetail(value); setDraft(supplierApplicationDraft(value.profile)); setSelectedVersion(value.version);
      } else {
        const values = await request<SupplierOnboardingSummary[]>(`supplier-onboarding/requests?scope=${reader ? "all" : "mine"}`, { signal: controller.signal });
        if (!controller.signal.aborted) setItems(values);
      }
    };
    void load().catch(e => { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "加载失败"); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [user, requestId, creating, reader, applicant, reload]);
  const filtered = useMemo(() => items.filter(item => (status === "all" || item.status === status)
    && `${item.supplierName} ${item.applicantName} ${SUPPLIER_TYPE_LABELS[item.supplierType]}`.toLocaleLowerCase("zh-CN").includes(query.trim().toLocaleLowerCase("zh-CN"))), [items, status, query]);
  const page = usePaginatedItems(filtered, `${status}:${query}`);
  const leave = async (target: string) => { if (await guard.requestLeave()) window.location.assign(pageUrl(target)); };
  const mutate = async (path: string, payload: unknown, success: string) => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError("");
    const body = JSON.stringify(payload), fingerprint = `${path}:${body}`;
    if (operation.current?.fingerprint !== fingerprint) operation.current = { fingerprint, key: createClientRequestId() };
    try {
      const result = await request<{ requestId: string }>(path, { method: "POST", headers: { "idempotency-key": operation.current.key }, body });
      if (!alive.current) return;
      guard.markClean(); operation.current = null; setEditing(false); setReason(""); setMessage(success);
      if (creating) { setDraft(emptyDraft()); lock.current = false; window.location.assign(pageUrl(`ui/suppliers/requests/${result.requestId}`)); }
      else setReload(value => value + 1);
    } catch (e) {
      if (!alive.current) return;
      setError(e instanceof Error ? e.message : "提交失败，请重试");
      if (reviewer && e instanceof RequestError && e.status === 409) setReload(value => value + 1);
    } finally { lock.current = false; if (alive.current) setBusy(false); }
  };
  const save = () => {
    if (!applicant || (!creating && (!detail || detail.status !== "returned" || detail.applicantId !== user?.id))) return;
    const payload = supplierApplicationPayload(draft);
    if (!payload.success) { setError(payload.error); return; }
    void mutate(creating ? "supplier-onboarding/requests" : `supplier-onboarding/requests/${requestId}/resubmit`, creating ? payload.data : { version: detail!.version, profile: payload.data }, "申请已提交，等待审批");
  };
  const decide = (action: "approve" | "return") => {
    if (!reviewer || !detail || detail.status !== "pending_approval" || selectedVersion !== detail.version || loading) return;
    if (action === "return" && !reason.trim()) { setError("请填写退回原因"); return; }
    void mutate(`supplier-onboarding/requests/${detail.requestId}/${action}`, { version: detail.version, ...(action === "return" ? { reason: reason.trim() } : {}) }, action === "approve" ? "已通过，供应商已进入正式资料库" : "已退回申请人修改");
  };
  if (identityError) return <Shell active="资料维护"><p role="alert">{identityError}</p><Button onClick={() => window.location.reload()}>重新核验</Button></Shell>;
  if (!user) return <Shell active="资料维护"><p role="status">核验身份中…</p></Shell>;
  if ((!applicant && !reader) || (creating && !applicant)) return <Shell active="资料维护"><p>当前账号不能提交新增申请。</p><a href={pageUrl("ui/suppliers/manage")}>返回资料维护</a></Shell>;
  const title = creating ? "申请新增供应商" : requestId ? "供应商申请详情" : reviewer ? "新增供应商审批" : reader ? "供应商申请" : "我的申请";
  const viewingCurrent = detail && selectedVersion === detail.version;
  const selected = detail ? supplierApplicationVersion(detail, selectedVersion) : undefined;
  const shown = selected?.profile;
  const duplicateConflict = !detail?.duplicateCheck || detail.duplicateCheck.formalSupplierCount + detail.duplicateCheck.pendingRequestCount > 0;
  const returnPath = todoReturnPath(window.location.search)??supplierRequestReturnPath(window.location.search);
  const listReturn=supplierRequestListPath(query,status);
  return <Shell active="资料维护"><div className="supplier-onboarding-page">
    <header className="page-heading supplier-center-heading"><div><h1><NavigationIcon route="/ui/suppliers/manage" size="title" />{title}</h1>
      <p>{reviewer ? "核对申请资料，通过后成为正式供应商" : reader ? "只读查看申请资料与审批历史" : "填写完整资料，审批通过后即可选用"}</p></div>
      <div className="supplier-center-heading__actions">{!requestId && applicant ? <a className="dx-button dx-button--primary" href={pageUrl("ui/suppliers/requests/new")}>申请新增供应商</a> : null}
        {returnPath ? <a className="dx-button" href={pageUrl(returnPath.replace(/^\//, ""))}>{todoReturnPath(window.location.search)?"返回待办列表":"返回申请列表"}</a> : null}
        <a className="dx-button" href={pageUrl("ui/suppliers/manage")}>资料维护</a><a className="dx-button" href={pageUrl("ui/suppliers")}>供应商目录</a>
      </div></header>
    {message ? <p className="supplier-center-notice" role="status">{message}</p> : null}
    {error ? <div className="supplier-center-error" role="alert">{error}<Button disabled={busy} onClick={async () => { if (await guard.requestLeave()) { setEditing(false); setReload(v => v + 1); } }}>刷新资料</Button></div> : null}
    {loading ? <p role="status">加载申请资料…</p> : creating || editing ? <Surface className="supplier-profile"><h2>{creating ? "新增申请" : "修改退回申请"}</h2>
      {!creating && detail?.decisions.at(-1)?.reason ? <p className="supplier-return-reason">退回原因：{detail.decisions.at(-1)?.reason}</p> : null}
      <SupplierProfileForm draft={draft} onDraft={setDraft} busy={busy} ready={!loading} creating application submitLabel={creating ? "提交申请" : "修改后重新提交"} onSave={save}
        onCancel={() => { if (creating) void leave("ui/suppliers/manage"); else void guard.requestLeave().then(ok => { if (ok) setEditing(false); }); }} /></Surface>
      : requestId && detail && shown && selected ? <>
        <Surface className="supplier-profile"><div className="supplier-profile__heading"><div><h2>{shown.supplierName}</h2><p>申请人：{detail.applicantName} · 第 {selected.version} 版提交于 {date(selected.submittedAt)}</p></div>
          <StatusBadge tone={selected.status === "approved" ? "success" : selected.status === "returned" ? "warning" : "info"}>{SUPPLIER_REQUEST_STATUS[selected.status]}</StatusBadge></div>
          <label className="supplier-version-choice">申请版本<select value={selectedVersion} disabled={busy} onChange={event => setSelectedVersion(Number(event.target.value))}>{detail.versions.map(v => <option key={v.version} value={v.version}>第 {v.version} 版{v.version === detail.version ? "（当前）" : "（历史）"} · {date(v.submittedAt)}</option>)}</select></label>
          <SupplierApplicationSnapshot profile={shown} />
          {detail.status === "approved" && viewingCurrent ? <p className="supplier-center-notice">已通过，申请内容已锁定。<a href={pageUrl(`ui/suppliers?supplierId=${detail.supplierId}`)}>查看正式资料</a></p> : null}
          {selected.decision?.decision === "returned" ? <p className="supplier-return-reason">退回原因：{selected.decision.reason}</p> : null}
          {applicant && detail.applicantId === user.id && detail.status === "returned" && viewingCurrent ? <Button variant="primary" disabled={busy} onClick={() => { setDraft(supplierApplicationDraft(detail.profile)); setEditing(true); }}>修改后重新提交</Button> : null}
          {reviewer && detail.status === "pending_approval" && viewingCurrent ? <form className="supplier-approval-actions" onSubmit={event => { event.preventDefault(); decide("return"); }}>
            <SupplierDuplicateCheck check={detail.duplicateCheck} />
            <Button type="button" disabled={busy} onClick={() => setReload(v => v + 1)}>刷新查重</Button>
            <label>退回原因<textarea aria-label="退回原因" maxLength={500} value={reason} disabled={busy} onChange={event => setReason(event.target.value)} placeholder="需要修改时，请说明具体原因" /></label>
            <div><Button type="button" className="supplier-approve" disabled={busy || duplicateConflict} onClick={() => decide("approve")}>通过</Button><Button type="submit" className="supplier-return" disabled={busy || !reason.trim()}>退回</Button></div>
          </form> : null}
        </Surface>
        <Surface className="supplier-application-history"><h2>审批记录</h2>{detail.decisions.length ? detail.decisions.map(d => <div key={d.version}><strong>第 {d.version} 版 · {d.decision === "approved" ? "通过" : "退回"}</strong><p>{d.reviewerName} · {date(d.decidedAt)}</p>{d.reason ? <p>{d.reason}</p> : null}</div>) : <p>暂无审批记录</p>}</Surface>
        <a href={pageUrl((returnPath ?? (reader ? "/ui/suppliers/requests" : "/ui/suppliers/manage")).replace(/^\//, ""))}>{todoReturnPath(window.location.search)?"返回待办列表":"返回申请列表"}</a>
      </> : !requestId ? <Surface className="supplier-directory"><div className="supplier-directory__filters">
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索供应商名称或申请人" aria-label="搜索申请" /><select aria-label="申请状态" value={status} onChange={e => setStatus(e.target.value as typeof status)}><option value="all">全部状态</option>{Object.entries(SUPPLIER_REQUEST_STATUS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
          <Button disabled={busy} onClick={() => setReload(v => v + 1)}>刷新</Button></div>
        <p>共 {filtered.length} 条申请</p>
        {filtered.length ? <SupplierApplicationList items={page.items} reviewer={reader} canApprove={reviewer} returnTo={listReturn}/> : <p className="supplier-center-empty">{query || status !== "all" ? "没有符合条件的申请" : "暂无申请，可点击上方申请新增供应商"}</p>}
        <ListPagination page={page.page} totalPages={page.totalPages} onPageChange={page.setPage} ariaLabel="申请列表分页" />
      </Surface> : null}
  </div></Shell>;
}
