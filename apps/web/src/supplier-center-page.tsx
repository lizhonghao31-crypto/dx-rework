import {LazyHistoryDetails} from "./lazy-history-details.js";
import {readSupplierWorkspaceQuery,supplierWorkspaceSearch} from "./supplier-workspace-query.js";
import { SupplierOnboardingPage } from "./supplier-onboarding-page.js";
import { canRequestSupplier, canApproveSupplier, canAccessSupplierMaintenance } from "./supplier-onboarding-model.js";
import { ProductionAnalysisPanel } from "./production-analysis-panel.js";
import { NavigationIcon } from "./navigation-icons.js";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button, StatusBadge, Surface } from "@dx-rework/ui";

import { createWebUrls } from "../url-contract.js";
import { verifySession, type AuthorizedUser } from "./auth.js";
import { registerInternalNavigationGuard } from "./internal-navigation.js";
import { createSupplierDraftGuard } from "./supplier-draft-guard.js";
import { SupplierDirectoryList, SupplierMaintenanceList } from "./supplier-center-lists.js";
import { confirmInApp } from "./system-dialog.js";
import { Shell } from "./components.js";
import { ListPagination, usePaginatedItems } from "./list-pagination.js";
import {
  SUPPLIER_TYPE_LABELS,
  canWriteSupplierProfiles,
  filterSupplierDirectory,
  nextSupplierSelection,
  supplierContractMissingLabels,
  type SupplierSummary,
} from "./supplier-center-model.js";
import "./supplier-center-page.css";

const { apiUrl, pageUrl } = createWebUrls(import.meta.env.BASE_URL);

import {emptyDraft,draftFromProfile,supplierDraftPayload,type SupplierProfile,type SupplierDraft} from "./supplier-profile-draft.js";
import { SupplierBatchPanel } from "./supplier-batch-panel.js";
import {SupplierProfileForm} from "./supplier-profile-form.js";

async function json<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(apiUrl(path), {
    credentials: "include",
    ...init,
    headers: {
      accept: "application/json",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
    throw new Error(body?.error?.message ?? `请求失败：${response.status}`);
  }
  return response.status === 204 ? undefined as T : await response.json() as T;
}


export function SupplierCenterNavigation({ active, canMaintain = false }: { active: "directory" | "manage"; canMaintain?: boolean }) {
  return (
    <nav className="supplier-center-tabs" aria-label="供应商中心">
      <a className={active === "directory" ? "active" : ""} aria-current={active === "directory" ? "page" : undefined} href={pageUrl("ui/suppliers")}>供应商目录</a>
      {canMaintain ? <a className={active === "manage" ? "active" : ""} aria-current={active === "manage" ? "page" : undefined} href={pageUrl("ui/suppliers/manage")}>资料维护</a> : null}
    </nav>
  );
}

// Distinct route components prevent a confirmed departure from retaining a create form.
export function SupplierDirectoryPage() { return <SupplierCenterPage mode="directory" />; }
export function SupplierMaintenancePage() { return <SupplierCenterPage mode="manage" />; }

export function SupplierCenterPage({ mode = "directory" }: { mode?: "directory" | "manage" }) {
  const [user, setUser] = useState<AuthorizedUser | null>(null);
  const [suppliers, setSuppliers] = useState<SupplierSummary[]>([]);
  const [initialQuery]=useState(()=>readSupplierWorkspaceQuery(typeof window==="undefined"?"":window.location.search));
  const [selectedId, setSelectedId] = useState(initialQuery.supplierId);
  const [profile, setProfile] = useState<SupplierProfile | null>(null);
  const [query, setQuery] = useState(initialQuery.q);
  const [supplierType, setSupplierType] = useState<"all" | SupplierSummary["supplierType"]>(initialQuery.type);
  const [status, setStatus] = useState<"active" | "inactive" | "all">(initialQuery.status);
  const [craft, setCraft] = useState(initialQuery.craft);
  const [completeness, setCompleteness] = useState<"all" | "missing" | "complete">(initialQuery.completeness);
  const [draft, setDraft] = useState<SupplierDraft>(emptyDraft);
  const [editing, setEditing] = useState(false);
  const [batchOpen, setBatchOpen] = useState(false);
  const [creating,setCreating]=useState(false),[identityLoading,setIdentityLoading]=useState(true),[identityError,setIdentityError]=useState("");
  const creationCode=useRef(""),savedSelection=useRef("");
  const [savedMessage,setSavedMessage]=useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [detailLoading, setDetailLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(()=>{const search=supplierWorkspaceSearch({q:query,type:supplierType,status,craft,completeness,supplierId:selectedId});window.history.replaceState(window.history.state,'',window.location.pathname+(search?'?'+search:''));},[query,supplierType,status,craft,completeness,selectedId]);
  const selectedRef = useRef(selectedId);
  const writeLock = useRef(false);
  const refreshLock = useRef(false);
  const dirty = creating || (editing && profile !== null && JSON.stringify(draft) !== JSON.stringify(draftFromProfile(profile)));
  const detailReady = !detailLoading && profile?.supplierId === selectedId && selectedId !== "";
  const [draftGuard] = useState(() => createSupplierDraftGuard({
    isBlocked: () => writeLock.current || refreshLock.current,
    confirm: () => confirmInApp("当前供应商有未保存修改，确定放弃这些修改？", {
        title: "未保存修改", confirmLabel: "放弃修改", cancelLabel: "继续编辑",
    }),
    discard: () => {
      creationCode.current = "";
      setDraft(emptyDraft());
      setCreating(false);
      setEditing(false);
    },
  }));
  draftGuard.setDirty(dirty);
  const discardChanges = draftGuard.requestLeave;

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!draftGuard.shouldBlock) return;
      event.preventDefault(); event.returnValue = "";
    };
    const unregister = registerInternalNavigationGuard(draftGuard.requestLeave);
    window.addEventListener("beforeunload", beforeUnload);
    return () => { unregister(); window.removeEventListener("beforeunload", beforeUnload); };
  }, [draftGuard]);

  const selectSupplier = async (id: string) => {
    if ((!creating && id === selectedRef.current) || !await discardChanges()) return;
    if (writeLock.current || refreshLock.current) return;
    selectedRef.current = id;
    savedSelection.current='';setSavedMessage('');
    setCreating(false);
    setError("");
    setProfile(null);
    setDraft(emptyDraft());
    setEditing(false);
    setDetailLoading(Boolean(id));
    setSelectedId(id);
  };

  const cancelEdit = async () => {
    if (creating) {if(await discardChanges()){setCreating(false);setEditing(false);setDraft(emptyDraft());}return;}
    if (!profile || !detailReady || !await discardChanges()) return;
    setDraft(draftFromProfile(profile));
    setEditing(false);
  };
  const canWrite = user ? canWriteSupplierProfiles(user) : false;
  const canMaintain = mode === "manage" && canWrite;

  const loadIdentity=async()=>{
    setIdentityLoading(true);setIdentityError("");
    try{const session=await verifySession();if(session==="denied")throw new Error("登录已失效，请重新登录");setUser(session.user);}
    catch(e){setUser(null);setIdentityError(e instanceof Error?e.message:"身份核验失败，请重试");}
    finally{setIdentityLoading(false);}
  };
  useEffect(()=>{let live=true;void verifySession().then(session=>{if(!live)return;if(session==="denied")throw new Error("登录已失效，请重新登录");setUser(session.user);}).catch(e=>{if(live)setIdentityError(e instanceof Error?e.message:"身份核验失败，请重试");}).finally(()=>{if(live)setIdentityLoading(false);});return()=>{live=false;};},[]);
  useEffect(()=>{let live=true;setRefreshing(true);void json<SupplierSummary[]>("master-data/suppliers?includeInactive=true").then(items=>{if(live)setSuppliers(items);}).catch(e=>{if(live)setError(e instanceof Error?e.message:"供应商目录加载失败");}).finally(()=>{if(live)setRefreshing(false);});return()=>{live=false;};},[]);

  const beginCreate=async()=>{
    if(!canMaintain||!await discardChanges()||writeLock.current||refreshLock.current)return;
    creationCode.current='SUP_'+Array.from(crypto.getRandomValues(new Uint8Array(12)),value=>value.toString(16).padStart(2,'0')).join('').toUpperCase();
    savedSelection.current='';setSavedMessage('');
    selectedRef.current='';setSelectedId('');setProfile(null);setDraft(emptyDraft());setError('');setDetailLoading(false);setCreating(true);setEditing(true);
  };

  const beginBatch = async () => {
    if (!canMaintain || !await discardChanges() || writeLock.current || refreshLock.current) return;
    creationCode.current = ""; savedSelection.current = ""; selectedRef.current = "";
    setSelectedId(""); setProfile(null);  setDraft(emptyDraft());
    setCreating(false); setEditing(false); setDetailLoading(false); setError(""); setSavedMessage("");
    setBatchOpen(true);
  };

  const refreshDirectory = async () => {
    if (!await discardChanges() || writeLock.current || refreshLock.current) return;
    refreshLock.current = true;
    setRefreshing(true);
    setCreating(false);
    setError("");
    // Invalidate the editable snapshot before either directory or detail reload.
    setProfile(null);
    setDraft(emptyDraft());
    setEditing(false);
    setDetailLoading(true);
    try {
      const items = await json<SupplierSummary[]>("master-data/suppliers?includeInactive=true");
      setSuppliers(items);
      const id = nextSupplierSelection(selectedRef.current, items, window.matchMedia("(max-width: 800px)").matches);
      selectedRef.current = id;
      setSelectedId(id);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "供应商目录刷新失败");
    } finally {
      refreshLock.current = false;
      setRefreshing(false);
      setReload((current) => current + 1);
    }
  };

  useEffect(() => {
    let mounted = true;
    if(creating)return ()=>{mounted=false;};
    setProfile(null);
    setDraft(emptyDraft());
    setEditing(false);
    setDetailLoading(Boolean(selectedId));
    if (!selectedId || refreshing) return () => { mounted = false; };
    void json<SupplierProfile>(`master-data/suppliers/${selectedId}`).then((nextProfile) => {
      if (!mounted || selectedRef.current !== selectedId) return;
      if (nextProfile.supplierId !== selectedId) {
        throw new Error("供应商详情与当前选择不一致，请刷新后重试。");
      }
      setProfile(nextProfile);
      setDraft(draftFromProfile(nextProfile));
      setEditing(mode === "manage" && canWrite && savedSelection.current !== selectedId);
    }).catch((loadError: unknown) => {
      if (mounted && selectedRef.current === selectedId) setError(loadError instanceof Error ? loadError.message : "供应商详情加载失败");
    }).finally(() => { if (mounted && selectedRef.current === selectedId) setDetailLoading(false); });
    return () => { mounted = false; };
  }, [selectedId, mode, canWrite, reload, refreshing, creating]);

  const filtered = useMemo(() => filterSupplierDirectory(suppliers, {
    query,
    type: supplierType,
    status,
    craft: mode === "directory" ? craft : "",
    completeness: mode === "manage" ? completeness : "all",
  }), [query, status, supplierType, suppliers, craft, completeness, mode]);
  const crafts = useMemo(() => [...new Set(suppliers.flatMap(supplier => supplier.supportedCrafts))].sort((a, b) => a.localeCompare(b, "zh-CN")), [suppliers]);
  const page = usePaginatedItems(filtered, `${query}:${supplierType}:${status}:${craft}:${completeness}`, 12);
  const missingLabels = supplierContractMissingLabels(profile?.contractDataMissing ?? []);
  const contractVisible = profile ? Object.hasOwn(profile, "contractEntityName") : false;

  const save = async () => {
    if(!canMaintain||writeLock.current||draftGuard.pending||refreshLock.current)return;
    if(!creating&&(!profile||!detailReady||profile.supplierId!==selectedRef.current))return;
    const parsed=supplierDraftPayload(draft,{creating,code:creationCode.current,version:profile?.version??1});
    if(!parsed.success){setError(parsed.error);return;}
    writeLock.current=true;setBusy(true);setError("");
    try{
      const result=await json<{supplierId:string;version:number}>(creating?"master-data/suppliers":`master-data/suppliers/${profile!.supplierId}/versions`,{method:"POST",body:JSON.stringify(parsed.data)});
      if(!creating&&result.supplierId!==profile!.supplierId)throw new Error("保存结果与当前供应商不一致，请刷新核对。");
      // Once committed, leave create mode before refreshing so a read failure cannot resubmit a new supplier.
      draftGuard.markClean();creationCode.current="";setDraft(emptyDraft());
      savedSelection.current=result.supplierId;setSavedMessage("资料已保存 · 版本 "+result.version);
      selectedRef.current=result.supplierId;setCreating(false);setSelectedId(result.supplierId);setEditing(false);setProfile(null);setDetailLoading(true);
      setReload(value=>value+1);
      try{setSuppliers(await json<SupplierSummary[]>("master-data/suppliers?includeInactive=true"));}
      catch{setError("资料已保存，目录刷新失败，请刷新目录核对。");}
    }catch(e){setError(e instanceof Error?e.message:"供应商资料保存失败");}
    finally{writeLock.current=false;setBusy(false);}
  };

  const toggleActive = async () => {
    if (!profile || !canMaintain || !detailReady || profile.supplierId !== selectedRef.current || writeLock.current || draftGuard.pending || refreshLock.current) return;
    setDraft({ ...draft, active: !profile.active, changeReason: profile.active ? "供应商停用" : "供应商恢复启用" });
    setEditing(true);
  };

  if (mode === "manage" && !identityLoading && user && !canWrite && canRequestSupplier(user)) return <SupplierOnboardingPage user={user} />;
  if (mode === "manage" && !identityLoading && user && !canWrite) {
    return <Shell active="资料维护"><p>当前账号没有资料维护权限。</p><a href={pageUrl("ui/suppliers")}>查看供应商目录</a></Shell>;
  }
  return (
    <Shell active={mode === "manage" ? "资料维护" : "供应商目录"}>
      <header className="page-heading supplier-center-heading">
        <div>
          <h1><NavigationIcon route={mode === "manage" ? "/ui/suppliers/manage" : "/ui/suppliers"} size="title" />{mode === "manage" ? "资料维护" : "供应商目录"}</h1>
          <p>{mode === "manage" ? "新增、修改、启停供应商资料并保留变更历史" : "查看供应商资料、工艺、常规产能及已有业务事实"}</p>
        </div>
        <div className="supplier-center-heading__actions">
          <StatusBadge tone={canMaintain ? "info" : "neutral"}>{identityLoading?"核验身份中":canMaintain ? "可维护" : "只读"}</StatusBadge>
          {canMaintain && user && canApproveSupplier(user) ? <a className="dx-button" href={pageUrl("ui/suppliers/requests")}>待审批申请</a> : null}
          {canMaintain && !batchOpen ? <><Button disabled={busy || refreshing} onClick={() => void beginBatch()}>批量录入</Button><Button variant="primary" disabled={busy||refreshing} onClick={()=>void beginCreate()}>新增供应商</Button></> : null}
        </div>
      </header>
      <SupplierCenterNavigation active={mode} canMaintain={user ? canAccessSupplierMaintenance(user) : false} />
      {identityError?<p role="alert">{identityError} <Button onClick={()=>void loadIdentity()}>重新核验</Button></p>:null}
      {savedMessage?<p className="supplier-center-notice" role="status">{savedMessage}</p>:null}
      {error ? <div className="supplier-center-error" role="alert"><b>请处理以下问题</b><p>{error}</p></div> : null}
      {mode === "manage" && !identityLoading && !identityError && !canWrite ? (
        <div className="supplier-center-notice" role="status">当前账号为只读，可查看资料与变更历史。</div>
      ) : null}
      {batchOpen && canMaintain ? <SupplierBatchPanel onClose={() => setBatchOpen(false)} onChanged={async () => { setSuppliers(await json<SupplierSummary[]>("master-data/suppliers?includeInactive=true")); }} /> : <div className={`supplier-center-workspace${selectedId||creating ? " has-selection" : ""}`}>
        <Surface className="supplier-directory">
          <div className="supplier-directory__heading">
            <div><h2>{mode === "manage" ? "供应商资料" : "供应商列表"}</h2><p>共 {filtered.length} 家</p></div>
            <Button onClick={() => void refreshDirectory()} disabled={busy || refreshing}>刷新</Button>
          </div>
          <div className="supplier-directory__filters">
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索名称、编码或工艺" aria-label="搜索供应商" />
            <select value={supplierType} onChange={(event) => setSupplierType(event.target.value as typeof supplierType)} aria-label="供应商类型">
              <option value="all">全部类型</option>
              {Object.entries(SUPPLIER_TYPE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
            <select value={status} onChange={(event) => setStatus(event.target.value as typeof status)} aria-label="启用状态">
              <option value="active">仅启用</option><option value="inactive">仅停用</option><option value="all">全部状态</option>
            </select>
            {mode === "directory" ? <select value={craft} onChange={event => setCraft(event.target.value)} aria-label="工艺">
              <option value="">全部工艺</option>{crafts.map(value => <option key={value} value={value}>{value}</option>)}
            </select> : <select value={completeness} onChange={event => setCompleteness(event.target.value as typeof completeness)} aria-label="资料完整度">
              <option value="all">全部资料</option><option value="missing">有缺项</option><option value="complete">完整</option>
            </select>}
          </div>
          {page.items.length ? mode === "directory"
            ? <SupplierDirectoryList suppliers={page.items} disabled={busy || refreshing} onSelect={id => void selectSupplier(id)} />
            : <SupplierMaintenanceList suppliers={page.items} canWrite={canMaintain} disabled={busy || refreshing} onSelect={id => void selectSupplier(id)} />
            : <p className="supplier-center-empty">没有符合条件的供应商。</p>}
          <ListPagination page={page.page} totalPages={page.totalPages} onPageChange={page.setPage} ariaLabel={mode === "manage" ? "资料维护分页" : "供应商目录分页"} />
        </Surface>

        <Surface className="supplier-profile">
          {creating&&canMaintain?<><div className="supplier-profile__heading"><Button disabled={busy} onClick={()=>void cancelEdit()}>返回目录</Button><h2>新增供应商</h2></div><SupplierProfileForm draft={draft} onDraft={setDraft} busy={busy} ready creating onSave={()=>void save()} onCancel={()=>void cancelEdit()}/></>:!profile || !detailReady ? <div className="supplier-center-empty" role="status"><h2>{detailLoading ? "正在加载供应商…" : "选择供应商"}</h2><p>{selectedId ? "详情未就绪时不能编辑或保存；加载失败可点击刷新重试。" : "从目录中选择一项查看资料与版本历史。"}</p></div> : (
            <>
              <div className="supplier-profile__heading">
                <Button className="supplier-profile__back" disabled={busy || refreshing} onClick={() => void selectSupplier("")}>返回目录</Button>
                <div><h2>{profile.supplierName}</h2><p>{profile.supplierCode} · 版本 {profile.version}</p></div>
                <StatusBadge tone={profile.active ? "success" : "warning"}>{profile.active ? "启用" : "停用"}</StatusBadge>
                {canMaintain ? <div className="supplier-profile__actions">
                  <Button disabled={busy || !detailReady} onClick={() => {
                    if (editing) { void cancelEdit(); return; }
                    setEditing(true);
                  }}>{editing ? "取消编辑" : "编辑资料"}</Button>
                  <Button disabled={busy || !detailReady} onClick={() => void toggleActive()}>{profile.active ? "停用" : "恢复"}</Button>
                </div> : null}
              </div>

              {editing && canMaintain ? (
                <SupplierProfileForm draft={draft} onDraft={setDraft} busy={busy} ready={detailReady} creating={false} onSave={()=>void save()} onCancel={()=>void cancelEdit()}/>
              ) : (
                <div className="supplier-profile__sections">
                  <section><h3>基础与联系</h3><dl><div><dt>联系人</dt><dd>{profile.contactPerson || "—"}</dd></div><div><dt>联系电话</dt><dd>{profile.contactPhone || "—"}</dd></div><div className="is-wide"><dt>地址</dt><dd>{profile.address || "—"}</dd></div><div className="is-wide"><dt>备注</dt><dd>{profile.notes || "—"}</dd></div></dl></section>
                  <section><h3>合同与收款</h3>
                    {missingLabels.length ? <div className="supplier-contract-warning"><b>合同资料缺项</b><p>{missingLabels.join("、")}</p></div> : <div className="supplier-contract-complete">合同资料完整</div>}
                    {contractVisible ? <dl><div><dt>合同主体</dt><dd>{profile.contractEntityName || "—"}</dd></div><div><dt>乙方代表</dt><dd>{profile.partyBRepresentative || "—"}</dd></div><div><dt>收款人</dt><dd>{profile.payeeName || "—"}</dd></div><div><dt>收款账号</dt><dd className="supplier-bank-account">{profile.bankAccount || "—"}</dd></div><div className="is-wide"><dt>开户行</dt><dd>{profile.bankName || "—"}</dd></div></dl> : <p className="supplier-profile__restricted">当前账号无权查看合同与收款字段。</p>}
                  </section>
                  <section><h3>工艺与产能</h3><dl><div className="is-wide"><dt>可承接工艺</dt><dd>{profile.supportedCrafts.length ? profile.supportedCrafts.join("、") : "尚未维护"}</dd></div><div><dt>常规日产能</dt><dd>{profile.dailyCapacity === null ? "尚未维护" : `${profile.dailyCapacity.toLocaleString("zh-CN")} 件 / 日`}</dd></div></dl></section>
                  <ProductionAnalysisPanel key={profile.supplierId} supplierId={profile.supplierId} view="supplier"/>
                  <LazyHistoryDetails key={`${profile.supplierId}-${profile.version}`} summary="变更历史"><SupplierVersionHistory supplierId={profile.supplierId}/></LazyHistoryDetails>
                </div>
              )}
            </>
          )}
        </Surface>
      </div>}
    </Shell>
  );
}

function SupplierVersionHistory({supplierId}:{supplierId:string}){
 const [history,setHistory]=useState<SupplierProfile[]>([]),[error,setError]=useState('');
 useEffect(()=>{const controller=new AbortController();void json<SupplierProfile[]>(`master-data/suppliers/${supplierId}/history`,{signal:controller.signal}).then(items=>{if(items.some(item=>item.supplierId!==supplierId))throw Error('供应商历史与当前选择不一致');if(!controller.signal.aborted)setHistory(items);}).catch(e=>{if(!controller.signal.aborted)setError(e instanceof Error?e.message:'供应商历史读取失败');});return()=>controller.abort();},[supplierId]);
 return <>{error&&<p role="alert">{error}</p>}<ol className="supplier-history">{history.map(version=><li key={version.version}><div><b>版本 {version.version}</b><StatusBadge tone={version.active?'success':'warning'}>{version.active?'启用':'停用'}</StatusBadge></div><p>{version.changeReason}</p><small>{new Date(version.changedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})} · 修改人 {version.changedBy}</small></li>)}</ol></>;
}
