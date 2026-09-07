import { NavigationIcon } from "./navigation-icons.js";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button, StatusBadge, Surface } from "@dx-rework/ui";

import { createWebUrls } from "../url-contract.js";
import { verifySession, type AuthorizedUser } from "./auth.js";
import { registerInternalNavigationGuard } from "./internal-navigation.js";
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

type SupplierProfile = SupplierSummary & Readonly<{
  notes: string;
  contactPerson: string | null;
  contactPhone: string | null;
  address: string | null;
  contractEntityName?: string | null;
  partyBRepresentative?: string | null;
  payeeName?: string | null;
  bankAccount?: string | null;
  bankName?: string | null;
  changeReason: string;
  changedBy: string;
  changedAt: string;
}>;

type SupplierDraft = {
  supplierName: string;
  active: boolean;
  notes: string;
  contactPerson: string;
  contactPhone: string;
  address: string;
  contractEntityName: string;
  partyBRepresentative: string;
  payeeName: string;
  bankAccount: string;
  bankName: string;
  supportedCrafts: string;
  dailyCapacity: string;
  changeReason: string;
};

const emptyDraft = (): SupplierDraft => ({
  supplierName: "",
  active: true,
  notes: "",
  contactPerson: "",
  contactPhone: "",
  address: "",
  contractEntityName: "",
  partyBRepresentative: "",
  payeeName: "",
  bankAccount: "",
  bankName: "",
  supportedCrafts: "",
  dailyCapacity: "",
  changeReason: "",
});

const draftFromProfile = (profile: SupplierProfile): SupplierDraft => ({
  supplierName: profile.supplierName,
  active: profile.active,
  notes: profile.notes,
  contactPerson: profile.contactPerson ?? "",
  contactPhone: profile.contactPhone ?? "",
  address: profile.address ?? "",
  contractEntityName: profile.contractEntityName ?? "",
  partyBRepresentative: profile.partyBRepresentative ?? "",
  payeeName: profile.payeeName ?? "",
  bankAccount: profile.bankAccount ?? "",
  bankName: profile.bankName ?? "",
  supportedCrafts: profile.supportedCrafts.join("、"),
  dailyCapacity: profile.dailyCapacity === null ? "" : String(profile.dailyCapacity),
  changeReason: "",
});

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

const nullable = (value: string): string | null => value.trim() || null;

export function SupplierCenterNavigation({ active }: { active: "directory" | "manage" }) {
  return (
    <nav className="supplier-center-tabs" aria-label="供应商中心">
      <a className={active === "directory" ? "active" : ""} href={pageUrl("ui/suppliers")}><NavigationIcon route="/ui/suppliers" />供应商目录</a>
      <a className={active === "manage" ? "active" : ""} href={pageUrl("ui/suppliers/manage")}><NavigationIcon route="/ui/suppliers/manage" />资料维护</a>
    </nav>
  );
}

export function SupplierCenterPage({ mode = "directory" }: { mode?: "directory" | "manage" }) {
  const [user, setUser] = useState<AuthorizedUser | null>(null);
  const [suppliers, setSuppliers] = useState<SupplierSummary[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [profile, setProfile] = useState<SupplierProfile | null>(null);
  const [history, setHistory] = useState<SupplierProfile[]>([]);
  const [query, setQuery] = useState("");
  const [supplierType, setSupplierType] = useState<"all" | SupplierSummary["supplierType"]>("all");
  const [status, setStatus] = useState<"active" | "inactive" | "all">("active");
  const [draft, setDraft] = useState<SupplierDraft>(emptyDraft);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [detailLoading, setDetailLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [reload, setReload] = useState(0);
  const selectedRef = useRef("");
  const writeLock = useRef(false);
  const discardLock = useRef(false);
  const refreshLock = useRef(false);
  const dirty = editing && profile !== null && JSON.stringify(draft) !== JSON.stringify(draftFromProfile(profile));
  const detailReady = !detailLoading && profile?.supplierId === selectedId && selectedId !== "";

  useEffect(() => {
    if (!dirty && !busy) return;
    const guard = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [dirty, busy]);

  const discardChanges = async (): Promise<boolean> => {
    if (writeLock.current || discardLock.current || refreshLock.current) return false;
    if (!dirty) return true;
    discardLock.current = true;
    try {
      return await confirmInApp("当前供应商有未保存修改，确定放弃这些修改？", {
        title: "未保存修改", confirmLabel: "放弃修改", cancelLabel: "继续编辑",
      });
    } finally { discardLock.current = false; }
  };

  useEffect(() => {
    if (!dirty && !busy) return;
    return registerInternalNavigationGuard(async () => {
      if (writeLock.current || refreshLock.current) return false;
      return confirmInApp("当前供应商有未保存修改，确定离开并放弃？", {
        title: "未保存修改", confirmLabel: "放弃并离开", cancelLabel: "继续编辑",
      });
    });
  }, [dirty, busy]);

  const selectSupplier = async (id: string) => {
    if (id === selectedRef.current || !await discardChanges()) return;
    if (writeLock.current || refreshLock.current) return;
    selectedRef.current = id;
    setError("");
    setProfile(null);
    setHistory([]);
    setDraft(emptyDraft());
    setEditing(false);
    setDetailLoading(Boolean(id));
    setSelectedId(id);
  };

  const cancelEdit = async () => {
    if (!profile || !detailReady || !await discardChanges()) return;
    setDraft(draftFromProfile(profile));
    setEditing(false);
  };
  const canWrite = user ? canWriteSupplierProfiles(user) : false;
  const canMaintain = mode === "manage" && canWrite;

  useEffect(() => {
    let mounted = true;
    void Promise.all([
      verifySession(),
      json<SupplierSummary[]>("master-data/suppliers?includeInactive=true"),
    ]).then(([session, items]) => {
      if (!mounted || session === "denied") return;
      setUser(session.user);
      setSuppliers(items);
      const id = nextSupplierSelection("", items, window.matchMedia("(max-width: 800px)").matches);
      selectedRef.current = id;
      setSelectedId(id);
    }).catch((loadError: unknown) => {
      if (mounted) setError(loadError instanceof Error ? loadError.message : "供应商目录加载失败");
    });
    return () => { mounted = false; };
  }, []);

  const refreshDirectory = async () => {
    if (!await discardChanges() || writeLock.current || refreshLock.current) return;
    refreshLock.current = true;
    setRefreshing(true);
    setError("");
    // Invalidate the editable snapshot before either directory or detail reload.
    setProfile(null);
    setHistory([]);
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
    setProfile(null);
    setHistory([]);
    setDraft(emptyDraft());
    setEditing(false);
    setDetailLoading(Boolean(selectedId));
    if (!selectedId || refreshing) return () => { mounted = false; };
    void Promise.all([
      json<SupplierProfile>(`master-data/suppliers/${selectedId}`),
      json<SupplierProfile[]>(`master-data/suppliers/${selectedId}/history`),
    ]).then(([nextProfile, nextHistory]) => {
      if (!mounted || selectedRef.current !== selectedId) return;
      if (nextProfile.supplierId !== selectedId || nextHistory.some((item) => item.supplierId !== selectedId)) {
        throw new Error("供应商详情与当前选择不一致，请刷新后重试。");
      }
      setProfile(nextProfile);
      setHistory(nextHistory);
      setDraft(draftFromProfile(nextProfile));
      setEditing(mode === "manage" && canWrite);
    }).catch((loadError: unknown) => {
      if (mounted && selectedRef.current === selectedId) setError(loadError instanceof Error ? loadError.message : "供应商详情加载失败");
    }).finally(() => { if (mounted && selectedRef.current === selectedId) setDetailLoading(false); });
    return () => { mounted = false; };
  }, [selectedId, mode, canWrite, reload, refreshing]);

  const filtered = useMemo(() => filterSupplierDirectory(suppliers, {
    query,
    type: supplierType,
    status,
  }), [query, status, supplierType, suppliers]);
  const page = usePaginatedItems(filtered, `${query}:${supplierType}:${status}`, 12);
  const missingLabels = supplierContractMissingLabels(profile?.contractDataMissing ?? []);
  const contractVisible = profile ? Object.hasOwn(profile, "contractEntityName") : false;

  const save = async () => {
    if (!profile || !canMaintain || !detailReady || profile.supplierId !== selectedRef.current || writeLock.current || discardLock.current || refreshLock.current) return;
    const errors: string[] = [];
    if (!draft.supplierName.trim()) errors.push("供应商显示名称不能为空");
    if (!draft.changeReason.trim()) errors.push("请填写修改原因");
    const dailyCapacity = draft.dailyCapacity.trim() ? Number(draft.dailyCapacity) : null;
    if (dailyCapacity !== null && (!Number.isInteger(dailyCapacity) || dailyCapacity <= 0)) {
      errors.push("常规日产能必须是正整数");
    }
    const supportedCrafts = draft.supportedCrafts.split(/[、,，]/).map((item) => item.trim()).filter(Boolean);
    if (new Set(supportedCrafts).size !== supportedCrafts.length) errors.push("可承接工艺不能重复");
    if (errors.length) {
      setError(errors.join("；"));
      return;
    }
    writeLock.current = true;
    const targetId = profile.supplierId;
    setBusy(true);
    setError("");
    try {
      await json(`master-data/suppliers/${profile.supplierId}/versions`, {
        method: "POST",
        body: JSON.stringify({
          supplierName: draft.supplierName.trim(),
          active: draft.active,
          notes: draft.notes.trim(),
          contactPerson: nullable(draft.contactPerson),
          contactPhone: nullable(draft.contactPhone),
          address: nullable(draft.address),
          contractEntityName: nullable(draft.contractEntityName),
          partyBRepresentative: nullable(draft.partyBRepresentative),
          payeeName: nullable(draft.payeeName),
          bankAccount: nullable(draft.bankAccount),
          bankName: nullable(draft.bankName),
          supportedCrafts,
          dailyCapacity,
          expectedVersion: profile.version,
          changeReason: draft.changeReason.trim(),
        }),
      });
      const items = await json<SupplierSummary[]>("master-data/suppliers?includeInactive=true");
      setSuppliers(items);
      const [nextProfile, nextHistory] = await Promise.all([
        json<SupplierProfile>(`master-data/suppliers/${profile.supplierId}`),
        json<SupplierProfile[]>(`master-data/suppliers/${profile.supplierId}/history`),
      ]);
      if (selectedRef.current !== targetId) return;
      if (nextProfile.supplierId !== targetId || nextHistory.some((item) => item.supplierId !== targetId)) {
        throw new Error("保存后返回的供应商不一致，请刷新核对。");
      }
      setProfile(nextProfile);
      setHistory(nextHistory);
      setDraft(draftFromProfile(nextProfile));
      setEditing(false);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "供应商资料保存失败");
    } finally {
      writeLock.current = false;
      setBusy(false);
    }
  };

  const toggleActive = async () => {
    if (!profile || !canMaintain || !detailReady || profile.supplierId !== selectedRef.current || writeLock.current || discardLock.current || refreshLock.current) return;
    setDraft({ ...draft, active: !profile.active, changeReason: profile.active ? "供应商停用" : "供应商恢复启用" });
    setEditing(true);
  };

  return (
    <Shell active={mode === "manage" ? "资料维护" : "供应商目录"}>
      <header className="page-heading supplier-center-heading">
        <div>
          <h1><NavigationIcon route={mode === "manage" ? "/ui/suppliers/manage" : "/ui/suppliers"} size="title" />供应商中心</h1>
          <p>统一查看供应商资料、合同缺项、工艺产能和变更历史。</p>
        </div>
        <div className="supplier-center-heading__actions">
          <StatusBadge tone={canMaintain ? "info" : "neutral"}>{canMaintain ? "Root 可维护" : "只读"}</StatusBadge>
          {canMaintain ? <a className="dx-button" href={`${pageUrl("ui/master-data")}?view=suppliers&tool=onboarding`}>新增与批量导入</a> : null}
        </div>
      </header>
      <SupplierCenterNavigation active={mode} />
      {error ? <div className="supplier-center-error" role="alert"><b>请处理以下问题</b><p>{error}</p></div> : null}
      {mode === "manage" && !canWrite ? (
        <div className="supplier-center-notice" role="status">当前账号可查看供应商资料，但 SSP-02 首期仅 Root 可维护。</div>
      ) : null}
      <div className={`supplier-center-workspace${selectedId ? " has-selection" : ""}`}>
        <Surface className="supplier-directory">
          <div className="supplier-directory__heading">
            <div><h2>供应商目录</h2><p>共 {filtered.length} 家</p></div>
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
          </div>
          <div className="supplier-directory__list">
            {page.items.length ? page.items.map((supplier) => (
              <button className={selectedId === supplier.supplierId ? "is-selected" : ""} disabled={busy || refreshing} onClick={() => void selectSupplier(supplier.supplierId)} key={supplier.supplierId}>
                <span><strong>{supplier.supplierName}</strong><small>{supplier.supplierCode} · {SUPPLIER_TYPE_LABELS[supplier.supplierType]}</small></span>
                <span className="supplier-directory__meta">
                  <StatusBadge tone={supplier.active ? "success" : "warning"}>{supplier.active ? "启用" : "停用"}</StatusBadge>
                  {supplier.contractDataMissing.length
                    ? <small>{supplier.contractDataMissing.length} 项合同资料缺失</small>
                    : <small className="is-complete">合同资料完整</small>}
                </span>
              </button>
            )) : <p className="supplier-center-empty">没有符合条件的供应商。</p>}
          </div>
          <ListPagination page={page.page} totalPages={page.totalPages} onPageChange={page.setPage} ariaLabel="供应商目录分页" />
        </Surface>

        <Surface className="supplier-profile">
          {!profile || !detailReady ? <div className="supplier-center-empty" role="status"><h2>{detailLoading ? "正在加载供应商…" : "选择供应商"}</h2><p>{selectedId ? "详情未就绪时不能编辑或保存；加载失败可点击刷新重试。" : "从目录中选择一项查看资料与版本历史。"}</p></div> : (
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
                <form className="supplier-profile-form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
                  <fieldset disabled={busy || !detailReady}><legend>基础与联系</legend>
                    <label>供应商显示名称<input value={draft.supplierName} onChange={(event) => setDraft({ ...draft, supplierName: event.target.value })} /></label>
                    <label>联系人<input value={draft.contactPerson} onChange={(event) => setDraft({ ...draft, contactPerson: event.target.value })} /></label>
                    <label>联系电话<input value={draft.contactPhone} onChange={(event) => setDraft({ ...draft, contactPhone: event.target.value })} /></label>
                    <label className="is-wide">地址<input value={draft.address} onChange={(event) => setDraft({ ...draft, address: event.target.value })} /></label>
                    <label className="is-wide">备注<textarea value={draft.notes} onChange={(event) => setDraft({ ...draft, notes: event.target.value })} /></label>
                  </fieldset>
                  <fieldset disabled={busy || !detailReady}><legend>合同与收款</legend>
                    <label>合同主体名称<input value={draft.contractEntityName} onChange={(event) => setDraft({ ...draft, contractEntityName: event.target.value })} /></label>
                    <label>乙方代表<input value={draft.partyBRepresentative} onChange={(event) => setDraft({ ...draft, partyBRepresentative: event.target.value })} /></label>
                    <label>收款人<input value={draft.payeeName} onChange={(event) => setDraft({ ...draft, payeeName: event.target.value })} /></label>
                    <label>收款账号<input value={draft.bankAccount} onChange={(event) => setDraft({ ...draft, bankAccount: event.target.value })} /></label>
                    <label className="is-wide">开户行<input value={draft.bankName} onChange={(event) => setDraft({ ...draft, bankName: event.target.value })} /></label>
                  </fieldset>
                  <fieldset disabled={busy || !detailReady}><legend>工艺与产能</legend>
                    <label className="is-wide">可承接工艺<input value={draft.supportedCrafts} placeholder="使用顿号或逗号分隔" onChange={(event) => setDraft({ ...draft, supportedCrafts: event.target.value })} /></label>
                    <label>常规日产能<input inputMode="numeric" value={draft.dailyCapacity} onChange={(event) => setDraft({ ...draft, dailyCapacity: event.target.value })} /></label>
                    <label>启用状态<select value={draft.active ? "active" : "inactive"} onChange={(event) => setDraft({ ...draft, active: event.target.value === "active" })}><option value="active">启用</option><option value="inactive">停用</option></select></label>
                    <label className="is-wide">修改原因<input value={draft.changeReason} onChange={(event) => setDraft({ ...draft, changeReason: event.target.value })} /></label>
                  </fieldset>
                  <div className="supplier-profile-form__actions"><Button type="button" disabled={busy} onClick={() => void cancelEdit()}>取消</Button><Button type="submit" variant="primary" disabled={busy || !detailReady}>{busy ? "保存中…" : "保存新版本"}</Button></div>
                </form>
              ) : (
                <div className="supplier-profile__sections">
                  <section><h3>基础与联系</h3><dl><div><dt>联系人</dt><dd>{profile.contactPerson || "—"}</dd></div><div><dt>联系电话</dt><dd>{profile.contactPhone || "—"}</dd></div><div className="is-wide"><dt>地址</dt><dd>{profile.address || "—"}</dd></div><div className="is-wide"><dt>备注</dt><dd>{profile.notes || "—"}</dd></div></dl></section>
                  <section><h3>合同与收款</h3>
                    {missingLabels.length ? <div className="supplier-contract-warning"><b>合同资料缺项</b><p>{missingLabels.join("、")}</p></div> : <div className="supplier-contract-complete">合同资料完整</div>}
                    {contractVisible ? <dl><div><dt>合同主体</dt><dd>{profile.contractEntityName || "—"}</dd></div><div><dt>乙方代表</dt><dd>{profile.partyBRepresentative || "—"}</dd></div><div><dt>收款人</dt><dd>{profile.payeeName || "—"}</dd></div><div><dt>收款账号</dt><dd className="supplier-bank-account">{profile.bankAccount || "—"}</dd></div><div className="is-wide"><dt>开户行</dt><dd>{profile.bankName || "—"}</dd></div></dl> : <p className="supplier-profile__restricted">当前账号无权查看合同与收款字段。</p>}
                  </section>
                  <section><h3>工艺与产能</h3><dl><div className="is-wide"><dt>可承接工艺</dt><dd>{profile.supportedCrafts.length ? profile.supportedCrafts.join("、") : "尚未维护"}</dd></div><div><dt>常规日产能</dt><dd>{profile.dailyCapacity === null ? "尚未维护" : `${profile.dailyCapacity.toLocaleString("zh-CN")} 件 / 日`}</dd></div></dl></section>
                  <section><h3>变更历史</h3><ol className="supplier-history">{history.map((version) => <li key={version.version}><div><b>版本 {version.version}</b><StatusBadge tone={version.active ? "success" : "warning"}>{version.active ? "启用" : "停用"}</StatusBadge></div><p>{version.changeReason}</p><small>{new Date(version.changedAt).toLocaleString("zh-CN")} · 修改人 {version.changedBy}</small></li>)}</ol></section>
                </div>
              )}
            </>
          )}
        </Surface>
      </div>
    </Shell>
  );
}
