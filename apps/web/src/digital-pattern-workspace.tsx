import {DigitalReadFailure} from './digital-read-failure.js';
import {PatternBoardLane,PatternBoardCard} from "./pattern-board-parts.js";
import {TaskWorkbenchSample} from "./task-workbench-sample.js";
import {LegacyPatternWorkspace} from "./legacy-pattern-workspace.js";
import "./digital-kpi-density.css";
import { NavigationIcon } from "./navigation-icons.js";
import { useEffect, useRef, useState } from "react";
import { Button, Surface, StatusBadge } from "@dx-rework/ui";
import { FilterBar, KpiCard, PageHeader, Pagination } from "@dx-rework/ui/production";
import { PATTERN_LANES, PatternWorkspaceFilterSchema, type PatternWorkspaceFilter, type PatternWorkspaceResult, type PatternWorkspaceTask } from "@dx-rework/contracts/digital-development-workspace";
import type { DigitalTask } from "@dx-rework/contracts/digital-production-tasks";
import type { DevelopmentSheet } from "@dx-rework/contracts/digital-development";
import { digitalRequest } from "./digital-production-api.js";
import { DigitalTasksPanel } from "./digital-production-tasks-panel.js";
import { DevelopmentExecutionPanel } from "./digital-development-execution-panel.js";
import type { DigitalAccessOptions } from "./digital-production-access-panel.js";
import { digitalTaskView } from "./digital-task-view.js";
import { createWebUrls } from "../url-contract.js";
import "./digital-development-workspace.css";
import { PatternRoomOrdersPage, PatternRoomAssignmentWorkspace } from "./pattern-room-orders-page.js";
import { BulkPatternWorkspace } from "./bulk-pattern-workspace.js";
import { patternTaskAction } from "./pattern-task-action.js";

const states = {uncreated: "尚未创建", pending: "等待前置", active: "办理中", blocked: "暂时办不了", completed: "已完成", cancelled: "已取消", inherited: "沿用", unavailable: "不可访问", not_applicable: "不适用"};
const date = (value: string | null) => value ? new Date(value).toLocaleString("sv-SE", {hour12: false, timeZone: "Asia/Shanghai", year:"numeric", month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit"}) : "未登记";
const duration = (seconds: number) => {if (!Number.isFinite(seconds)) return '时间待核实'; const minutes = Math.floor(Math.max(0, seconds) / 60), days = Math.floor(minutes / 1440), hours = Math.floor(minutes % 1440 / 60); return days ? `${days}天${hours ? `${hours}小时` : ''}` : hours ? `${hours}小时${minutes % 60 ? `${minutes % 60}分` : ''}` : `${minutes}分`;};
const stay = (task: PatternWorkspaceTask, asOf: string) => {
  if (!task.node.enteredAt) return "尚未启动计时";
  const end = ['completed','cancelled'].includes(task.node.state) ? task.node.actualAt : asOf;
  if (!end) return "停留时间待核实";
  return `停留 ${duration((Date.parse(end) - Date.parse(task.node.enteredAt)) / 1000)}`;
};
const deadline = (task: PatternWorkspaceTask) => task.node.expectedAt ? task.node.expectedPrecision === 'date' ? task.node.expectedAt.slice(0,10) : date(task.node.expectedAt) : task.node.sla === 'not_started' ? '未启动' : '未设时限';
function initialFilter(): PatternWorkspaceFilter {
  const parsed = PatternWorkspaceFilterSchema.safeParse(Object.fromEntries([...new URLSearchParams(window.location.search)].filter(([key]) => ["page", "search", "group", "lane", "owner", "state", "risk", "scope", "business"].includes(key))));
  return parsed.success ? parsed.data : PatternWorkspaceFilterSchema.parse({});
}
export function DigitalPatternWorkspace({selectedOnly=false,initialTask,initialAccess}:{selectedOnly?:boolean;initialTask?:DigitalTask;initialAccess?:DigitalAccessOptions}={}) {
  const [section,setSection]=useState(new URLSearchParams(window.location.search).get('workspace')==='preparation'?'bulk':['bulk','legacy'].includes(new URLSearchParams(window.location.search).get('section')??'')?new URLSearchParams(window.location.search).get('section')!:'development');
  const [bulkOrder,setBulkOrder]=useState<string|null>(new URLSearchParams(window.location.search).get('bulkOrder')??(new URLSearchParams(window.location.search).get('workspace')==='preparation'?new URLSearchParams(window.location.search).get('selected'):null));
  const [search, setSearch] = useState(initialFilter().search);
  const [filter, setFilter] = useState(initialFilter), [result, setResult] = useState<PatternWorkspaceResult | null>(null);
  const [options, setOptions] = useState<DigitalAccessOptions | null>(null), [error, setError] = useState<Error|null>(null), [refresh, setRefresh] = useState(0), [notice,setNotice]=useState("");
  const [accessError,setAccessError]=useState<Error|null>(null),[accessRevision,setAccessRevision]=useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(() => new URLSearchParams(window.location.search).get("task"));
  const [selected, setSelected] = useState<DigitalTask | null>(null), [sheet, setSheet] = useState<DevelopmentSheet | null>(null), [detailError, setDetailError] = useState<Error|null>(null);
  const [tab, setTab] = useState(new URLSearchParams(window.location.search).get("taskView") === "correct" ? "历史记录" : "当前办理"), [collapsed, setCollapsed] = useState(false);
  const [suggestedWorker,setSuggestedWorker]=useState<{id:string;name:string}|null>(null);
  const [patternOrderId,setPatternOrderId]=useState<string|null>(null);
  const paths=useRef<Record<string,string>>({});
  const [historical,setHistorical]=useState(new URLSearchParams(window.location.search).get("source")==="standalone");
  const canViewAll=Boolean(options?.roles.some(role=>["root_superuser","owner_group","production_management","pattern_room_supervisor","development_clerk"].includes(role)));
  const showBoard=filter.scope!=="dispatch";
  const urls = createWebUrls(import.meta.env.BASE_URL);
  const persist = (next: PatternWorkspaceFilter, task: string | null) => {
    const query = new URLSearchParams(Object.entries({...next,scope:section==="bulk"?(next.scope==="all"?"all":"mine"):next.scope}).filter(([, value]) => value !== undefined && value !== "").map(([key, value]) => [key, String(value)]));
    if (task) query.set("task", task);
    if (section !== "development") query.set("section", section);
    if (section === "bulk" && bulkOrder) query.set("bulkOrder", bulkOrder);
    window.history.replaceState(window.history.state, "", `${urls.pageUrl("ui/digital-pattern-room")}?${query}`);
  };
  useEffect(() => {
    let live=true;setOptions(null);setAccessError(null);
    void (initialAccess?Promise.resolve(initialAccess):digitalRequest<DigitalAccessOptions>("access/options")).then(access=>{if(live){
      if(!new URLSearchParams(window.location.search).has("scope"))setFilter(value=>({...value,scope:access.roles.some(role=>["root_superuser","owner_group","production_management","pattern_room_supervisor","development_clerk"].includes(role))?"all":"mine"}));
      setOptions(access);
    }}).catch(reason=>{if(live)setAccessError(reason);});
    return()=>{live=false;};
  },[initialAccess,accessRevision]);
  useEffect(() => {
    let live = true; const controller=new AbortController();setError(null);
    if(selectedOnly||section!=="development"||historical||!options)return()=>{live=false;};
    setResult(null);
    const query = new URLSearchParams(Object.entries({...filter,business:"development"}).filter(([, value]) => value !== undefined && value !== "").map(([key, value]) => [key, String(value)]));
    void digitalRequest<PatternWorkspaceResult>(`workspaces/pattern?${query}`,"GET",undefined,undefined,{signal:controller.signal}).then(data=>{if(live)setResult(data);}).catch(reason=>{if(live){setResult(null);setError(reason);}});
    return () => {live = false;controller.abort();};
  }, [filter, refresh,section,options,selectedOnly,historical]);
  useEffect(() => {
    let live = true; setSelected(null); setSheet(null); setPatternOrderId(null); setSuggestedWorker(null); setDetailError(null);
    if (selectedId) void (refresh===0&&initialTask?.taskId===selectedId?Promise.resolve(initialTask):digitalRequest<DigitalTask>(`tasks/${selectedId}`)).then(async task => {
      if (!live) return;
      // A direct query cannot turn a non-development task into a board operation.
      if(task.taskKind==='bulk_pattern'&&task.orderId){setSelected(task);setBulkOrder(task.orderId);setSection('bulk');return;}
      if (!task.taskKind.startsWith("development_")) throw Error("该任务请在原业务入口办理");
      setSelected(task);
      if (task.sourceId) {const document = await digitalRequest<DevelopmentSheet>(`sources/${task.sourceId}/development?round=${task.routeVersion}`); if (live) setSheet(document);}
    }).catch(reason => {if (live) {setSelected(null); setSheet(null); setDetailError(reason);}});
    return () => {live = false;};
  }, [selectedId, refresh,initialTask]);
  const update = (patch: Partial<PatternWorkspaceFilter>) => {const next = PatternWorkspaceFilterSchema.parse({...filter, page: 1, ...patch,business:"development"}); setFilter(next); setResult(null); setSelectedId(null); persist(next, null);};
  const changed = (confirmation?:string) => {if(confirmation)setNotice(confirmation);setRefresh(value => value + 1);};
  const refreshReads=()=>{if(!options)setAccessRevision(value=>value+1);else changed();};
  const choose = (id: string) => {window.location.assign(`${urls.pageUrl("ui/digital-production")}?task=${id}&returnTo=${encodeURIComponent(window.location.pathname+window.location.search)}`);};
  const selectedNode = [...(result?.items ?? []), ...(result?.risks ?? [])].find(item => item.node.instanceId === selectedId);
  const waitingFor=selectedNode?.node.blockers.map(item=>item.label).join("、")||selected?.blockedReason||"前置工序完成";
  const requestedView = digitalTaskView(window.location.search);
  const view = requestedView === "correct" ? "correct" : requestedView === "read" ? "read" : selected && ["completed","cancelled"].includes(selected.state) ? "read" : "handle";
  const taskUrl = selected ? `${urls.pageUrl("ui/digital-production")}?task=${selected.taskId}&taskView=${view}&returnTo=${encodeURIComponent(window.location.pathname+window.location.search)}` : "";
  const sections=<nav className="development-tabs pattern-business-tabs" aria-label="板房业务">{[['development','开发岗位任务'],['bulk','大货纸样与唛架'],['legacy','杂事看板']].map(([key,label])=><button key={key} aria-pressed={section===key} onClick={()=>{
    paths.current[section]=window.location.search;
    const target=paths.current[key!]??`?section=${key}&scope=${canViewAll?'all':'mine'}`;
    window.history.replaceState(window.history.state,'',`${urls.pageUrl("ui/digital-pattern-room")}${target}`);
    setSection(key!);setSelectedId(null);setSelected(null);setSheet(null);setBulkOrder(null);setDetailError(null);setResult(null);
    const next=initialFilter();setFilter(next);setSearch(next.search);setHistorical(new URLSearchParams(target).get('source')==='standalone');
  }}>{label}</button>)}</nav>;
  const sourceFilter=<label className="pattern-source-filter">任务来源<select aria-label="任务来源" value={historical?'standalone':'development'} onChange={event=>{const legacy=event.target.value==='standalone';setHistorical(legacy);setResult(null);setSelectedId(null);window.history.replaceState(window.history.state,'',urls.pageUrl('ui/digital-pattern-room')+(legacy?'?section=development&source=standalone&kind=pattern&origin=standalone':`?section=development&scope=${canViewAll?'all':'mine'}`));if(!legacy){const next=initialFilter();setFilter(next);setSearch(next.search);}}}><option value="development">开发单工序</option><option value="standalone">历史独立打板</option></select></label>;
  if(section==='development'&&historical&&!selectedOnly)return <div className="pattern-workspace pattern-golden dx-production-refined">{sections}<PageHeader title="板房管理台"/>{sourceFilter}<PatternRoomOrdersPage embedded standaloneOnly/></div>;
  if(selected?.sourceId&&selected.taskKind.startsWith('development_')&&view!=='correct')return <TaskWorkbenchSample key={selected.taskId} task={selected} onClose={()=>{setSelectedId(null);setSelected(null);persist(filter,null);}} onChanged={()=>changed()}/>;
  if(section==='legacy')return <div className="pattern-workspace pattern-golden dx-production-refined">{sections}<LegacyPatternWorkspace/></div>;
  if(section==='bulk')return <div className="pattern-workspace pattern-golden dx-production-refined">
    {!selectedOnly&&<>{sections}<div className="development-breadcrumb"><a href={urls.pageUrl('ui/digital-cockpit')}>生产管理座舱</a> › <strong>板房管理台</strong></div><PageHeader title="板房管理台"/></>}
    {options?<BulkPatternWorkspace orderId={bulkOrder} canViewAll={canViewAll} onOrderChange={orderId=>{setBulkOrder(orderId);setSelectedId(null);setSelected(null);}}/>:accessError?<DigitalReadFailure error={accessError} onRetry={refreshReads} retryLabel="重试读取岗位权限"/>:<p role="status">正在读取岗位权限…</p>}
  </div>;
  if(!options)return <div className="pattern-workspace pattern-golden dx-production-refined">{!selectedOnly&&<>{sections}<PageHeader title="板房管理台" actions={<Button onClick={refreshReads}>刷新</Button>}/></>}{accessError?<DigitalReadFailure error={accessError} onRetry={refreshReads} retryLabel="重试读取岗位权限"/>:<p role="status">正在读取岗位权限…</p>}</div>;
  return <div className="pattern-workspace pattern-golden dx-production-refined">
    {!selectedOnly&&<>
    {sections}<div className="development-breadcrumb"><a href={urls.pageUrl('ui/digital-cockpit')}>生产管理座舱</a> › <strong>板房管理台</strong></div>
    <PageHeader title="板房管理台" actions={<Button onClick={refreshReads}>刷新</Button>}/>
    {error&&<DigitalReadFailure error={error} onRetry={refreshReads} retryLabel="重试读取任务"/>}{notice&&<p role="status" className="pattern-submit-notice">{notice}</p>}
    {sourceFilter}{showBoard&&<div className="pattern-group-cards">{PATTERN_LANES.map((lane,index) => <KpiCard key={lane.key} icon={<NavigationIcon name={(["FileText","Shirt","Scissors","Settings","Shirt","ClipboardCheck","PackageCheck"] as const)[index]??"FileText"} />} className={`pattern-lane-kpi lane-${index}`} label={lane.label} value={result ? lane.groups.reduce((total,group) => total+result.counts[group],0) : "—"} detail={result?.riskCounts?`临期 ${lane.groups.reduce((total,group)=>total+result.riskCounts[group].dueSoon,0)} / 逾期 ${lane.groups.reduce((total,group)=>total+result.riskCounts[group].overdue,0)}`:error?"本次资料未能读取":"临期 / 逾期读取中"} selected={filter.lane === lane.key} onClick={() => update({lane:filter.lane === lane.key ? undefined : lane.key,group:undefined})}/>)}</div>}

    <div className="pattern-workspace-body"><section className="dx-production-panel pattern-task-list" data-layout={showBoard?"board":"tasks"}><div className="pattern-board-title"><h2>{showBoard?"岗位进度看板":filter.scope==="dispatch"?"待确认派工":filter.scope==="personnel"?"人员安排":"岗位任务"}</h2><span>{result ? `${result.archiveTotal} 款 · ${result.total} 项任务` : error ? "读取失败" : "读取中…"}</span>{(filter.lane || filter.group) && <Button onClick={() => update({lane:undefined,group:undefined})}>显示全部环节</Button>}</div>
    <div className="pattern-board-filters"><nav className="development-tabs" aria-label="岗位任务范围">{([[canViewAll?"all":"mine","全部进度"],...(options?.roles.some(role=>["pattern_room_supervisor","root_superuser","owner_group","production_management"].includes(role))?[["unassigned","待分派"]]:[]),...(options?.roles.some(role=>["pattern_room_supervisor","root_superuser"].includes(role))?[["dispatch","正式派工"]]:[])]).map(([scope,label])=><button key={scope} aria-pressed={filter.scope===scope} onClick={()=>update({scope:scope as PatternWorkspaceFilter["scope"],owner:undefined})}>{label}</button>)}</nav><FilterBar as="div"><form className="pattern-keyword-search" onSubmit={event=>{event.preventDefault();update({search:search.trim(),owner:undefined});}}><label>关键词<input placeholder="款号 / PO / 客户 / 当前主办人" maxLength={100} value={search} onChange={event=>setSearch(event.target.value)} onKeyDown={event=>{if(event.key==='Enter'&&event.nativeEvent.isComposing)event.preventDefault();}}/></label><Button type="submit">查询</Button></form>
      <label>任务状态<select value={filter.state} onChange={event => update({state: event.target.value as PatternWorkspaceFilter["state"]})}>{Object.entries({ongoing: "在办与待启动", all: "全部当前任务", pending: "等待前置", active: "办理中", blocked: "暂时办不了", completed: "已完成"}).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
      <label>风险<select value={filter.risk ?? ""} onChange={event => update({risk: (event.target.value || undefined) as PatternWorkspaceFilter["risk"]})}><option value="">全部风险</option><option value="overdue">超时</option><option value="due_soon">临期</option><option value="blocked">受阻</option><option value="unknown">时间待核实</option></select></label>
    </FilterBar><p>{result ? `${result.archiveTotal} 个开发档案 · ${result.total} 项真实任务` : error ? "任务资料未能读取" : "正在读取授权任务…"}</p></div>
      {showBoard?<>      <div className="pattern-board-scroll" role="region" aria-label="开发环节看板，可横向滚动查看全部环节" tabIndex={0}><div className={`pattern-board-columns ${filter.lane || filter.group ? "is-filtered" : ""}`}>{PATTERN_LANES.filter(lane => (!filter.lane || lane.key === filter.lane) && (!filter.group || (lane.groups as readonly string[]).includes(filter.group))).map(lane => <PatternBoardLane lane={lane.key} title={lane.label} key={lane.key} count={result ? lane.groups.reduce((total,group) => total+result.counts[group],0) : "—"} icon={<NavigationIcon name={({materials:'FileText',pattern:'Shirt',cutting:'Scissors',craft:'Settings',sewing:'Shirt',check:'ClipboardCheck',shipping:'PackageCheck'} as const)[lane.key]}/>} onAll={()=>update({lane:lane.key,group:undefined})}>
      {result?.items.filter(task => (lane.groups as readonly string[]).includes(task.group)).map(task => <PatternBoardCard key={task.node.instanceId} overdue={task.node.risks.includes("overdue")} onClick={() => choose(task.node.instanceId)}>
        <strong>{task.designStyleNo}</strong><small>{task.customer ?? "通用开发"} · 第 {task.node.round ?? 1} 轮</small><small>{task.node.label}</small><small>当前主办：{task.node.owner?.name ?? "待派工"}</small>
        <StatusBadge tone={task.node.risks.includes("overdue") || task.node.state === "blocked" ? "danger" : task.node.state === "completed" ? "success" : "info"}>{task.node.risks.includes("overdue") ? "超时" : states[task.node.state]}</StatusBadge>
        <small>{task.node.blockers.map(blocker=>blocker.label).join("；")||"无已记录阻断"}</small><small>{result ? stay(task,result.asOf) : '计时读取中'}</small>
        <small title={task.node.expectedAt ?? undefined}>截止 {deadline(task)}</small><span className="pattern-task-action">{task.nativeAssignment?"分派师傅":patternTaskAction(task.node)}</span>
      </PatternBoardCard>)}
      {result && !result.items.some(task => (lane.groups as readonly string[]).includes(task.group)) && <p>{lane.groups.some(group => result.counts[group] > 0) ? "本页无此环节任务" : "暂无任务"}</p>}
      </PatternBoardLane>)}</div></div>{!filter.lane && !filter.group && <p className="pattern-board-scroll-hint">横向滚动看板可查看全部七个环节</p>}
</>:      <div className="development-table-scroll pattern-role-task-table"><table><thead><tr><th>款号</th><th>客户 / 轮次</th><th>当前任务</th><th>主办人</th><th>状态</th><th>要求完成</th><th>停留</th><th>操作</th></tr></thead><tbody>{result?.items.map(task=><tr key={task.node.instanceId} className={selectedId===task.node.instanceId?"is-selected":""}><td><strong>{task.designStyleNo}</strong></td><td>{task.customer??"通用开发"} · 第{task.node.round??1}轮</td><td>{task.node.label}</td><td>{task.node.owner?.name??"待派工"}</td><td><StatusBadge tone={task.node.state==="blocked"||task.node.risks.includes("overdue")?"danger":task.node.state==="completed"?"success":"info"}>{states[task.node.state]}</StatusBadge></td><td>{deadline(task)}</td><td>{result?stay(task,result.asOf):"—"}</td><td><Button type="button" variant="primary" onClick={()=>choose(task.node.instanceId)}>{task.nativeAssignment?"分派师傅":patternTaskAction(task.node)}</Button></td></tr>)}</tbody></table></div>}
      {!result && !error && <p role="status">正在读取授权任务…</p>}{result && !result.items.length && <p>当前筛选暂无真实任务</p>}
      {!error&&<Pagination page={filter.page} pageSize={15} total={result?.total ?? null} onPage={page => update({page})}/>}
    </section></div>
    </>}
    {(selectedOnly||selectedId)&&<section className="dx-production-panel pattern-task-detail" aria-label="选中任务详情">
      {!selectedId && <p className="development-empty">选择任务，下方直接办理当前工作，并可查看资料与历史。</p>}
      {detailError&&<DigitalReadFailure error={detailError} onRetry={()=>changed()} retryLabel="重试读取任务详情"/>}
      {selectedId && !selected && !detailError && <p role="status">正在读取任务…</p>}
      {selected && options && <><header className="pattern-detail-heading"><h2>{sheet?.designStyleNo ?? selected.identity?.designStyleNo ?? '原任务'} <small>{sheet?.customerCode ?? selected.identity?.customerCode ?? '通用开发'} · 第 {selected.routeVersion} 轮</small> · {selected.label} · {selected.assigneeName??"待派工"} · 截止 {date(selected.dueAt)} {selectedNode?.node.risks.length ? <StatusBadge tone={selectedNode.node.risks.includes('overdue') || selectedNode.node.risks.includes('blocked') ? 'danger' : 'warning'}>{selectedNode.node.risks.map(risk => ({overdue:'超时',due_soon:'临期',blocked:'受阻',unknown:'待核实'})[risk]).join(' / ')}</StatusBadge> : null}</h2><button className="development-text-action" aria-expanded={!collapsed} onClick={() => setCollapsed(value => !value)}>{collapsed ? '展开' : '收起'}</button></header>
      {!collapsed && <><nav className="development-tabs" aria-label="板房任务资料">{['当前办理','基本信息','面辅料情况','历史记录'].map(label => <button key={label} aria-pressed={tab === label} onClick={() => setTab(label)}>{label}</button>)}</nav>
      {tab === '基本信息' && <div className="pattern-detail-columns"><section><h3>基本信息</h3><dl><dt>款号</dt><dd>{sheet?.designStyleNo ?? selected.identity?.designStyleNo ?? '无可见资料'}</dd><dt>开发类型</dt><dd>{sheet?.developmentType ?? '未读取'}</dd><dt>当前环节</dt><dd>{selected.label}</dd><dt>主办人</dt><dd>{selected.assigneeName ?? '待派工'}</dd><dt>截止时间</dt><dd>{selected.slaHours === null ? '无时限' : date(selected.dueAt)}</dd></dl></section><section><h3>面辅料情况</h3><div className="pattern-material-summary">{sheet?.document?.materials.filter(material => material.requiredThisRound).map(material => <p key={material.materialId}><strong>{material.category} · {material.label || material.name}</strong><span>{material.available || sheet.materialEvents.some(event => event.materialId === material.materialId && ['到货','确认代用'].includes(event.action)) ? '已登记到料 / 代用' : '尚缺到料记录'}</span></p>)}{!sheet?.document?.materials.some(material => material.requiredThisRound) && <p>本轮无可见必需材料记录</p>}</div></section><section><h3>当前交接</h3><dl><dt>任务</dt><dd>{selected.label}</dd><dt>进入</dt><dd>{date(selected.enteredAt)}</dd><dt>状态</dt><dd>{selected.state === 'ready' ? '可办理' : selected.state === 'completed' ? '已完成' : selected.state === 'blocked' ? '受阻' : selected.state === 'pending' ? '待前置' : '已取消'}</dd><dt>本轮完成</dt><dd>{selected.routeProgress.completed} / {selected.routeProgress.applicable}</dd><dt>缺项</dt><dd>{selected.blockedReason || selectedNode?.node.blockers.map(item => item.label).join('；') || '无已记录阻断'}</dd></dl></section><section className="pattern-quick-actions"><h3>快捷操作</h3><Button variant="primary" onClick={() => setTab('当前办理')}>{view === 'handle' ? '办理当前任务' : '查看任务记录'}</Button>{selected.canManage && view === 'handle' && <Button onClick={() => setTab('当前办理')}>查看分派 / 改派</Button>}<Button onClick={() => setTab('历史记录')}>查看历史</Button><a href={taskUrl}>打开原任务详情</a></section></div>}
      {tab === '面辅料情况' && <div className="pattern-material-table development-table-scroll"><BusinessMaterials sheet={sheet}/></div>}
      {['当前办理','历史记录'].includes(tab) && <div className="pattern-detail-operation"><aside className="pattern-task-source"><h3>本轮制作资料</h3>{selected.state==="pending"&&<p role="status">等待{waitingFor}，尚未开始计时</p>}<p>{sheet?.designStyleNo??selected.identity?.designStyleNo} · 第{selected.routeVersion}轮</p><PatternTaskGallery files={sheet?.document?.files.filter(file=>["款图","局部图"].includes(file.kind)).map(file=>({id:file.attachmentId,kind:file.kind,url:urls.apiUrl(`digital-production/sources/${selected.sourceId}/development/attachments/${file.attachmentId}`)}))??[]}/><dl className="pattern-gallery-facts"><dt>客户</dt><dd>{sheet?.customerCode??selected.identity?.customerCode??"通用开发"}</dd><dt>开发类型</dt><dd>{sheet?.developmentType??"未读取"}</dd><dt>设计师</dt><dd>{sheet?.designerName??"未读取"}</dd><dt>当前任务</dt><dd>{selected.label}</dd><dt>主办人</dt><dd>{selected.assigneeName??"待派工"}</dd></dl><p>{sheet?.document?.instructions||"本轮没有制作说明"}</p><dl><dt>本轮打板数量</dt><dd>{sheet?.document?.quantity??"未登记"}</dd><dt>本轮打样尺码</dt><dd>{sheet?.document?.sampleSize||"未登记"}</dd></dl></aside><div className={!["development_materials","development_material_recheck"].includes(selected.taskKind)&&options.roles.some(role=>["pattern_room_supervisor","root_superuser"].includes(role))&&view==="handle"?"pattern-supervisor-operation":undefined}>
        {tab==='当前办理'&&view==='handle'&&!['development_materials','development_material_recheck'].includes(selected.taskKind)&&patternOrderId&&selected.routeVersion===(sheet?.latestRoundNumber??1)&&options.roles.some(role=>["pattern_room_supervisor","root_superuser"].includes(role))&&<section className="pattern-supervisor-assignment"><PatternRoomAssignmentWorkspace orderId={patternOrderId} suggestedWorker={suggestedWorker??undefined} onChanged={()=>changed("已确认正式派工；车缝按核配、纸样、裁板等实际前置条件启动。")}/></section>}
        {tab === '当前办理' && view === 'handle' && selected.sourceId && sheet?.status === 'published' && selected.routeVersion === (sheet.latestRoundNumber ?? 1) && <Surface><DevelopmentExecutionPanel key={`${selected.taskId}:${refresh}`} sourceId={selected.sourceId} materialRevision={sheet.materialEvents.length} taskId={selected.taskId} onChanged={changed} workspace prioritizeMaterialCheck onPatternOrderLoaded={setPatternOrderId} onPreassignedSewingLoaded={setSuggestedWorker}/></Surface>}

        {view!=="handle"&&sheet&&<section className="development-task-basis"><h3>本轮材料事实（只读）</h3><div className="development-table-scroll"><BusinessMaterials sheet={sheet}/></div><p>打板数量：{sheet.document?.quantity??"未登记"} · 打样尺码：{sheet.document?.sampleSize||"未登记"}</p></section>}
        <div className="pattern-original-task-record"><DigitalTasksPanel key={`${selected.taskId}:${refresh}:${tab}`} initialTask={selected} options={options} taskId={selected.taskId} compact embeddedBusiness feedbackOnly={["development_materials","development_material_recheck"].includes(selected.taskKind)} view={tab === '历史记录' && view === 'handle' ? 'read' : view} onChanged={changed}/></div>
      </div></div>}

      </>}
      </>}
    </section>}
  </div>;
}
function BusinessMaterials({sheet}: {sheet: DevelopmentSheet | null}) {
  return <table><thead><tr><th>材料</th><th>规格 / 数量</th><th>到料事实</th><th>原计划日期</th></tr></thead><tbody>{sheet?.document?.materials.filter(material => material.requiredThisRound).map(material => <tr key={material.materialId}><td>{material.category} · {material.label || material.name}</td><td>{material.specification || '—'} · {material.quantity || '—'}</td><td>{sheet.materialReadiness?.find(row=>row.materialId===material.materialId)?.available?'本轮有效可用（核验 / 到料 / 代用）':sheet.materialReadiness?.find(row=>row.materialId===material.materialId)?.missing.join('、')||'尚未逐项核验'}</td><td>{sheet.materialEvents.filter(event => event.materialId === material.materialId && event.action === '修改预计日期').at(-1)?.expectedDate ?? material.expectedDate ?? '未登记'}</td></tr>)}</tbody></table>;
}

function PatternTaskGallery({files}:{files:{id:string;kind:string;url:string}[]}){
 const [selected,setSelected]=useState<string|null>(null);
 const current=files.find(file=>file.id===selected)??files[0];
 return <div className="pattern-task-gallery"><div className="pattern-task-gallery-main">{current?<a href={current.url} target="_blank" rel="noreferrer"><img src={current.url} alt={current.kind}/></a>:<span>暂无可见款图</span>}</div><div className="pattern-task-gallery-thumbnails">{files.map((file,index)=><button type="button" key={file.id} aria-label={`查看款图 ${index+1}`} aria-pressed={file.id===current?.id} onClick={()=>setSelected(file.id)}><img src={file.url} alt={file.kind}/></button>)}</div></div>;
}
