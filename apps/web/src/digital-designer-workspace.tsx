import { useEffect, useState } from "react";
import { Button, Surface } from "@dx-rework/ui";
import { BusinessTable, FilterBar, KpiCard, PageHeader, Pagination } from "@dx-rework/ui/production";
import { DEVELOPMENT_VIEWS, DevelopmentWorkspaceFilterSchema, type DevelopmentWorkspaceFilter, type DevelopmentWorkspaceItem, type DevelopmentWorkspaceResult } from "@dx-rework/contracts/digital-development-workspace";
import type { DigitalCustomer } from "@dx-rework/contracts/digital-production";
import { digitalRequest } from "./digital-production-api.js";
import { DigitalDevelopmentPanel } from "./digital-development-panel.js";
import { DevelopmentCreateForm, type DevelopmentCreateIntent } from "./digital-development-create-form.js";
import type { DigitalAccessOptions } from "./digital-production-access-panel.js";
import { navigateInternalPage } from "./internal-navigation.js";
import { createWebUrls } from "../url-contract.js";
import "./digital-development-workspace.css";

const urls = createWebUrls(import.meta.env.BASE_URL);
function initialFilter(): DevelopmentWorkspaceFilter {
  const parameters = new URLSearchParams(window.location.search);
  const parsed = DevelopmentWorkspaceFilterSchema.safeParse(Object.fromEntries([...parameters].filter(([key]) => ["page", "search", "customer", "view"].includes(key))));
  return parsed.success ? parsed.data : DevelopmentWorkspaceFilterSchema.parse({});
}
export function DigitalDesignerWorkspace() {
  const [filter, setFilter] = useState(initialFilter), [result, setResult] = useState<DevelopmentWorkspaceResult | null>(null);
  const [options, setOptions] = useState<{creationEnabled: boolean; customers: DigitalCustomer[]} | null>(null), [access, setAccess] = useState<DigitalAccessOptions | null>(null);
  const [intent, setIntent] = useState<DevelopmentCreateIntent | null>(null), [confirm, setConfirm] = useState<DevelopmentWorkspaceItem | null>(null);
  const [error, setError] = useState(""), [refresh, setRefresh] = useState(0);
  const selected = new URLSearchParams(window.location.search).get("development");
  const round = Number(new URLSearchParams(window.location.search).get("round")) || undefined;
  const contextUrl = (parameters: Record<string, string> = {}) => {
    const query = new URLSearchParams({workspace: "designer", ...Object.fromEntries(Object.entries(filter).filter(([, value]) => value !== undefined && value !== "").map(([key, value]) => [key, String(value)])), ...parameters});
    return `${urls.pageUrl("ui/digital-production")}?${query}`;
  };
  useEffect(() => {
    let live = true; setError("");
    const query = new URLSearchParams(Object.entries(filter).filter(([, value]) => value !== undefined && value !== "").map(([key, value]) => [key, String(value)]));
    void Promise.all([digitalRequest<DevelopmentWorkspaceResult>(`workspaces/designer?${query}`), digitalRequest<typeof options>("options"), digitalRequest<DigitalAccessOptions>("access/options")])
      .then(([data, nextOptions, nextAccess]) => {if (live) {setResult(data); setOptions(nextOptions); setAccess(nextAccess);}}).catch(reason => {if (live) {setResult(null); setError(reason.message);}});
    return () => {live = false;};
  }, [filter, refresh]);
  const update = (patch: Partial<DevelopmentWorkspaceFilter>) => {
    const next = DevelopmentWorkspaceFilterSchema.parse({...filter, page: 1, ...patch}); setFilter(next); setResult(null);
    const query = new URLSearchParams({workspace: "designer", ...Object.fromEntries(Object.entries(next).filter(([, value]) => value !== undefined && value !== "").map(([key, value]) => [key, String(value)]))});
    window.history.replaceState(window.history.state, "", `${urls.pageUrl("ui/digital-production")}?${query}`);
  };
  if (selected) return <div className="development-workspace pattern-orders digital-production"><DigitalDevelopmentPanel sourceId={selected} {...(round ? {initialRound: round} : {})} onClose={() => {void navigateInternalPage(contextUrl()).then(() => setRefresh(value => value + 1));}}/></div>;
  return <div className="development-workspace pattern-orders digital-production">
    <PageHeader title="设计师创建订单" description="产品开发与订购信息沿用同一档案" actions={options?.creationEnabled && access?.create && <div className="pattern-actions"><Button onClick={() => {setIntent("development"); setConfirm(null);}}>产品开发（无确定订单）</Button><Button onClick={() => {setIntent("certain_order"); setConfirm(null);}}>产品开发（有确定订单）</Button></div>}/>
    {error && <p role="alert">{error}</p>}
    {intent && options ? <DevelopmentCreateForm key={confirm?.journey.id ?? intent} intent={intent} {...(confirm ? {source: confirm.journey} : {})} customers={options.customers} onCancel={() => {setIntent(null); setConfirm(null); setRefresh(value => value + 1);}} onCreated={id => {void navigateInternalPage(contextUrl({development: id}));}}/> : <>
      <div className="development-view-cards">{DEVELOPMENT_VIEWS.map(view => <KpiCard key={view.key} label={view.label} value={result?.counts[view.key] ?? "—"} detail="开发/订单档案" selected={filter.view === view.key} onClick={() => update({view: view.key})}/>)}</div>
      <Surface><FilterBar as="div"><label>款号 / PO<input maxLength={100} value={filter.search} onChange={event => update({search: event.target.value})}/></label><label>客户<select value={filter.customer ?? ""} onChange={event => update({customer: event.target.value || undefined})}><option value="">全部客户</option>{result?.customers.map(customer => <option key={customer}>{customer}</option>)}</select></label><Button onClick={() => setRefresh(value => value + 1)}>刷新</Button></FilterBar>
        <div className="development-table-scroll"><BusinessTable><thead><tr><th>款号 / 客户</th><th>业务视图</th><th>当前开发</th><th>订购信息</th><th>办理</th></tr></thead><tbody>{result?.items.map(item => <tr key={item.journey.id}><td><strong>{item.journey.designStyleNo}</strong><small>{item.journey.temporaryStyleNo ?? ""} · {item.journey.customer ?? "通用开发"}</small></td><td>{DEVELOPMENT_VIEWS.find(view => view.key === item.view)?.label}{item.journey.orderId && !item.journey.sourceId && <small>待完善开发资料</small>}</td><td>{item.journey.sourceVersion ? `第 ${item.journey.selectedRound ?? 1} 轮` : "待填写开发单"}<small>{item.journey.progress.development ? `本轮 ${item.journey.progress.development.completed} / ${item.journey.progress.development.applicable} 项` : "尚未发布开发路线"}</small>{item.journey.adoptedRound && <small>大货采用第 {item.journey.adoptedRound} 轮</small>}</td><td>{item.journey.lines.length ? `${item.journey.lines.length} 个款色 / PO` : "尚无确定订单"}<small>{item.journey.orderNumbers.join(" / ")}</small></td><td><div className="pattern-actions">{item.journey.sourceId && <a href={contextUrl({development: item.journey.sourceId, ...(item.journey.selectedRound && item.journey.sourceVersion ? {round: String(item.journey.selectedRound)} : {})})}>开发单 / 版本 / 打印</a>}{item.canConfirm && options?.creationEnabled && access?.create && <Button onClick={() => {setConfirm(item); setIntent("confirm_order");}}>客户确定订单</Button>}{item.journey.orderId && <a href={`${urls.pageUrl("ui/digital-production")}?order=${item.journey.orderId}&returnTo=${encodeURIComponent(contextUrl())}`}>查看订购信息</a>}</div></td></tr>)}</tbody></BusinessTable></div>
        {result && !result.items.length && <p>当前视图暂无档案</p>}
        {!result && !error && <p role="status">正在读取开发档案…</p>}
        <Pagination page={filter.page} pageSize={20} total={result?.total ?? null} onPage={page => update({page})}/>
      </Surface>
    </>}
  </div>;
}
