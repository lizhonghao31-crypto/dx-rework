import {useForegroundWait} from "./foreground-loading.js";
import {registerSessionInvalidator} from "./auth-session.js";
import {MiscOrderRows} from "./misc-order-rows.js";
import {DevelopmentAssignmentEntry} from "./development-assignment-table.js";
import { SearchableSelect } from "./search-select.js";
import { PatternNodeHistory, PatternRoundRecord } from "./pattern-round-record.js";
import { patternSelectedStage, patternWorkflow } from "./pattern-workflow.js";
import { PatternOrderCard } from "./pattern-order-card.js";
import { PatternMaterials } from "./pattern-materials.js";
import { ListPagination } from "./list-pagination.js";
import { SearchSelect } from "./search-select.js";
import { confirmInApp } from "./system-dialog.js";
import { PatternField as InsetField, PatternProgress } from "./pattern-controls.js";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { z } from "zod";
import { Button, Surface } from "@dx-rework/ui";
import { formatBusinessDecimal } from "@dx-rework/contracts/business-display";
import { AssignPatternOrderSchema, PATTERN_ORDER_STATUS_LABELS, PatternOrderDetailSchema, PatternOrderListSchema, PatternPeopleFiltersSchema, PatternWorkerOptionsSchema, RecordPatternHoursSchema, type PatternOrderDetail } from "@dx-rework/contracts/pattern-orders";
import { Header } from "./components.js";
import { createClientRequestId } from "./client-request-id.js";
import { useDebouncedValue } from "./use-debounced-value.js";
import { PatternOrderForm } from "./pattern-order-form.js";
import { PatternOrderExceptions, type PatternExceptionAction,type DevelopmentTransferContext } from "./pattern-order-exceptions.js";
import { patternRequest, patternTime, patternUrls } from "./pattern-order-client.js";
import { patternListPath, patternReturnPath, readPatternListQuery } from "./pattern-order-query.js";
import { canLeaveInternalPage } from "./internal-navigation.js";
import { useInternalReturnScroll } from "./use-internal-return-scroll.js";
import "./pattern-room.css";
import "./pattern-governed.css";

const { pageUrl } = patternUrls;
const assignmentMoney = (value:string|number):string => {const [whole,fraction=""] = formatBusinessDecimal(value,2).split(".");return `${whole}.${fraction.padEnd(2,"0")}`;};

export function PatternRoomOrdersPage({embedded=false,miscOnly=false,standaloneOnly=false,onListPathChange,headerActions}:{headerActions?:ReactNode;embedded?:boolean;miscOnly?:boolean;standaloneOnly?:boolean;onListPathChange?:(path:string)=>void}={}) {
  const [initial] = useState(() => readPatternListQuery(window.location.search));
  const [data, setData] = useState<z.infer<typeof PatternOrderListSchema> | null>(null), [error, setError] = useState("");
  const [q, setQ] = useState(initial.q), [status, setStatus] = useState(initial.status), [creatorId, setCreatorId] = useState(initial.creatorId), [workerId, setWorkerId] = useState(initial.workerId), [page, setPage] = useState(initial.page);
  const [kind, setKind] = useState(miscOnly?"misc":standaloneOnly?"pattern":initial.kind);
  const [people, setPeople] = useState<z.infer<typeof PatternPeopleFiltersSchema> | null>(null), [refresh, setRefresh] = useState(0), [loading, setLoading] = useState(true);
  const search = useDebouncedValue(q.trim(), 250);
  const nativeListPath = patternListPath({ q: search, kind, status, creatorId, workerId, page, ...(standaloneOnly?{origin:"standalone" as const}:initial.origin?{origin:initial.origin}:{}) });
  const listPath=embedded?`/ui/digital-pattern-room?${standaloneOnly?"section=development&source=standalone":"section=legacy"}&${nativeListPath.split("?")[1]??""}`:nativeListPath;
  const detailHref = (id: string) => `${pageUrl(`ui/pattern-room/orders/${id}`)}?${new URLSearchParams({ returnTo: listPath })}`;
  useEffect(() => { window.history.replaceState(window.history.state, "", pageUrl(listPath)); onListPathChange?.(listPath); }, [listPath,onListPathChange]);
  useInternalReturnScroll(!loading && data !== null);
  useEffect(() => {
    const abort = new AbortController(); setLoading(true); setError("");
    const params = new URLSearchParams({ page: String(page), q: search });
    if (status) params.set("status", status); if (creatorId) params.set("creatorId", creatorId); if (workerId) params.set("workerId", workerId);
    if (kind) params.set("kind", kind);
    if(standaloneOnly||initial.origin)params.set("origin","standalone");
    void patternRequest(`orders?${params}`, PatternOrderListSchema, { signal: abort.signal }).then(result => { if (!abort.signal.aborted) setData(result); }).catch(e => { if (!abort.signal.aborted) { setError(e.message); setData(null); } }).finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [search, kind, status, creatorId, workerId, page, refresh, standaloneOnly, initial.origin]);
  useEffect(() => {
    if (!data?.canFilterPeople) { setPeople(null); return; }
    const abort = new AbortController();
    void patternRequest("people-filters", PatternPeopleFiltersSchema, { signal: abort.signal }).then(result => { if (!abort.signal.aborted) setPeople(result); }).catch(e => { if (!abort.signal.aborted) setError(e.message); });
    return () => abort.abort();
  }, [data?.canFilterPeople, refresh]);
  return <div className={`pattern-orders rework-query-content${embedded&&miscOnly?" misc-workspace":""}`}>{!embedded&&<Header title={miscOnly?"杂事看板":"历史打板/杂事看板"} badge="订单打板" badgePlacement="subtitle" />}
    {error ? <Surface><p role="alert">{error}</p><Button onClick={() => setRefresh(value => value + 1)}>重新读取</Button></Surface> : null}
    {embedded&&miscOnly&&<header className="misc-workspace-header"><h2>杂事任务</h2>{headerActions}</header>}
    {data ? <>
      <Surface className={embedded&&miscOnly?"misc-list-filter-surface":""}>
      <div className="pattern-fields pattern-filters">{embedded&&miscOnly?<label className="misc-keyword-filter">搜索<input aria-label="搜索款号、订单号或任务名称" placeholder="任务名称 / 款号 / 订单号" maxLength={100} value={q} onChange={e=>{setQ(e.target.value);setPage(1);}}/></label>:<InsetField label="搜索款号、订单号或任务名称" placeholder="款号 / 订单号 / 任务名称" value={q} onChange={e => { setQ(e.target.value); setPage(1); }} />}
        {!miscOnly&&!standaloneOnly&&<label>订单类型<select value={kind} onChange={e => { setKind(e.target.value); setPage(1); }}><option value="">全部</option><option value="pattern">打板</option><option value="misc">杂事</option></select></label>}
        <label>订单状态<select value={status} onChange={e => { setStatus(e.target.value); setPage(1); }}><option value="">全部状态</option>{Object.entries(PATTERN_ORDER_STATUS_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        {people ? <><label>创建人<SearchableSelect value={creatorId} onChange={e => { setCreatorId(e.target.value); setPage(1); }}><option value="">全部创建人</option>{people.creators.map(person => <option key={person.id} value={person.id}>{person.name}</option>)}</SearchableSelect></label>
          <label>板房师傅<SearchableSelect value={workerId} onChange={e => { setWorkerId(e.target.value); setPage(1); }}><option value="">全部师傅</option>{people.workers.map(person => <option key={person.id} value={person.id}>{person.name}</option>)}</SearchableSelect></label></> : null}
      </div>
      </Surface>
      {embedded&&miscOnly?<MiscOrderRows items={data.items} href={detailHref} canDelete={data.canDelete} busy={loading} onDeleted={id=>{
        setData(current=>current?{...current,items:current.items.filter(item=>item.orderId!==id)}:current);setPage(1);setRefresh(value=>value+1);
      }}/>:<div className={embedded?"pattern-compact-records":"reporting-order-grid"} aria-busy={loading}>
        {data.items.map(order => <PatternOrderCard compact={embedded} key={order.orderId} order={order} href={detailHref(order.orderId)} canDelete={data.canDelete} busy={loading} onDeleted={() => {
          setData(current => current ? { ...current, items: current.items.filter(item => item.orderId !== order.orderId) } : current);
          setPage(1); setRefresh(value => value + 1);
        }} />)}
      </div>}
      {!data.items.length ? <p className="pattern-empty">没有符合条件的订单。</p> : null}
      <div className="pattern-pagination"><span>共 {formatBusinessDecimal(data.totalCount)} 单</span><ListPagination page={data.page} totalPages={data.totalPages} busy={loading} onPageChange={setPage} ariaLabel="订单打板/杂事看板分页" /></div>
    </> : loading ? <p role="status">正在读取订单…</p> : null}
  </div>;
}

export function PatternRoomOrderDetailPage({ orderId }: { orderId: string }) {
  const params = new URLSearchParams(window.location.search);
  // The app keeps this route mounted when SPA navigation changes only its query.
  // Reset the entire workspace, including pending requests and writable state.
  const viewKey = JSON.stringify([orderId, params.get("round"), params.get("node"),params.get("readOnly")]);
  return <PatternRoomDetailWorkspace key={viewKey} orderId={orderId} />;
}

export function PatternRoomAssignmentWorkspace({orderId,onChanged,suggestedWorker}:{orderId:string;onChanged?:()=>void;suggestedWorker?:{id:string;name:string}|undefined}) {
  return <PatternRoomDetailWorkspace key={orderId} orderId={orderId} assignmentOnly onChanged={onChanged} suggestedWorker={suggestedWorker}/>;
}
export function PatternRoomExecutionWorkspace({orderId,onChanged,disabled=false,developmentContext}:{orderId:string;onChanged?:()=>void;disabled?:boolean;developmentContext?:DevelopmentTransferContext|undefined}){return <PatternRoomDetailWorkspace orderId={orderId} inlineExecution onChanged={onChanged} disabled={disabled} developmentContext={developmentContext}/>;}
function PatternRoomDetailWorkspace({ orderId, assignmentOnly=false, inlineExecution=false,disabled=false,onChanged,suggestedWorker,developmentContext }: { orderId: string; assignmentOnly?:boolean;inlineExecution?:boolean;disabled?:boolean;developmentContext?:DevelopmentTransferContext|undefined; onChanged?:((()=>void)|undefined);suggestedWorker?:{id:string;name:string}|undefined }) {
  const [order, setOrder] = useState<PatternOrderDetail | null>(null), [error, setError] = useState(""), [localBusy, setBusy] = useState(false), [editing, setEditing] = useState(false);
  const [detailLoading,setDetailLoading]=useState(true),[foregroundKey,setForegroundKey]=useState<string>();
  const [refresh,setRefresh]=useState({revision:0,silent:false});
  const detailRequest=useRef<AbortController|null>(null),retrying=useRef(false),started=useRef(false);
  const session=useRef(0),sessionAtRender=session.current;
  const busy=localBusy||disabled||detailLoading;
  const reloadDetail=(silent:boolean)=>setRefresh(current=>({revision:current.revision+1,silent}));
  const retryDetail=async()=>{
    if(busy||retrying.current||detailRequest.current)return;
    retrying.current=true;
    try {
      if(await canLeaveInternalPage()){
        setEditing(false);
        reloadDetail(false);
      }else retrying.current=false;
    }catch(error){
      retrying.current=false;
      setError(error instanceof Error ? error.message : "订单读取失败");
    }
  };
  const [workers, setWorkers] = useState<z.infer<typeof PatternWorkerOptionsSchema>>([]), [workerSearch, setWorkerSearch] = useState(""), [personId, setPersonId] = useState("");
  const prefillFor=useRef<string|null>(null),personPrefilledFor=useRef<string|null>(null);
  useEffect(()=>{if(assignmentOnly&&suggestedWorker&&prefillFor.current!==orderId){prefillFor.current=orderId;setWorkerSearch(suggestedWorker.name);}},[assignmentOnly,suggestedWorker,orderId]);
  useEffect(()=>{if(assignmentOnly&&suggestedWorker&&!personId&&personPrefilledFor.current!==orderId){const person=workers.find(worker=>worker.userId===suggestedWorker.id);if(person){personPrefilledFor.current=orderId;setPersonId(person.personId);}}},[assignmentOnly,suggestedWorker,workers,personId]);
  const [hours, setHours] = useState("");
  const [workflowOpen, setWorkflowOpen] = useState(() => !window.matchMedia("(max-width: 760px)").matches);
  const [reworkAmount, setReworkAmount] = useState(""), [exception, setException] = useState<PatternExceptionAction | null>(null);
  const search = useDebouncedValue(workerSearch.trim(), 250), requestedRound = assignmentOnly||inlineExecution?null:new URLSearchParams(window.location.search).get("round");
  const requestedNode = assignmentOnly||inlineExecution?null:new URLSearchParams(window.location.search).get("node");
  const historyRead=!assignmentOnly&&!inlineExecution&&new URLSearchParams(window.location.search).get('readOnly')==='history';
  const staleRound = Boolean(order && requestedRound && requestedRound !== order.currentRoundId);
  const attempt = useRef<{ body: string; action: string; key: string } | null>(null);
  const historical = new URLSearchParams();
  if (requestedRound) historical.set("round", requestedRound);
  if (requestedNode) historical.set("node", requestedNode);
  const detailTarget=`orders/${orderId}${historical.size ? `?${historical}` : ""}`;
  useForegroundWait(foregroundKey);
  useEffect(()=>registerSessionInvalidator(()=>{
    session.current++;
    detailRequest.current?.abort();
    setForegroundKey(undefined);
    setOrder(null);setWorkers([]);setEditing(false);setException(null);
    setRefresh(current=>({revision:current.revision+1,silent:true}));
  }),[]);
  useEffect(() => {
    const abort = new AbortController();
    const foreground=!refresh.silent&&(!started.current||retrying.current);
    detailRequest.current=abort;
    started.current=true;
    retrying.current=false;
    setForegroundKey(foreground?JSON.stringify([detailTarget,refresh.revision]):undefined);
    setDetailLoading(true);setError("");
    void patternRequest(detailTarget, PatternOrderDetailSchema, { signal: abort.signal }).then(data => {
      if (!abort.signal.aborted) { setOrder(data); setException(null); }
    }).catch(e => {
      if (!abort.signal.aborted) { setOrder(null); setError(e.message); }
    }).finally(()=>{
      if(detailRequest.current===abort&&!abort.signal.aborted){
        detailRequest.current=null;setDetailLoading(false);setForegroundKey(undefined);
      }
    });
    return () => {abort.abort();if(detailRequest.current===abort)detailRequest.current=null;};
  }, [detailTarget,refresh]);
  useEffect(() => {
    if (historyRead || !order?.actions.assign || staleRound) return;
    const abort = new AbortController(), epoch=session.current;
    void patternRequest(`workers?q=${encodeURIComponent(search)}`, PatternWorkerOptionsSchema, { signal: abort.signal }).then(result => { if (!abort.signal.aborted&&session.current===epoch) setWorkers(result); }).catch(e => { if (!abort.signal.aborted&&session.current===epoch) setError(e.message); });
    return () => abort.abort();
  }, [order?.actions.assign, staleRound, search,historyRead]);
  const showUpdatedOrder = (updated: PatternOrderDetail) => {
    if(session.current!==sessionAtRender)return;
    if(assignmentOnly||inlineExecution){setOrder(updated);onChanged?.();return;}
    const params = new URLSearchParams(window.location.search);
    params.delete("node");
    if (params.has("round")) params.set("round", updated.currentRoundId);
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${params.size ? `?${params}` : ""}`);
    setOrder(updated);
  };
  const act = async (action: "assign" | "complete" | "handoff" | "hours") => {
    if(assignmentOnly&&action!=="assign")return;
    if (!order || busy || historyRead || staleRound || order.historicalView) return;
    const current = order.rounds.find(round => round.roundId === order.currentRoundId);
    const input = { roundId: order.currentRoundId, version: order.version, ...(action === "assign" ? { personId, ...(current?.roundType === "rework" ? { amount: reworkAmount } : {}) } : {}), ...(action === "hours" ? { hours } : {}) };
    if (action === "assign") { const parsed = AssignPatternOrderSchema.safeParse(input); if (!parsed.success) { setError(parsed.error.issues[0]?.message ?? "请填写有效派工信息"); return; } }
    if (action === "hours") { const parsed = RecordPatternHoursSchema.safeParse(input); if (!parsed.success) { setError(parsed.error.issues[0]?.message ?? "请填写有效工时"); return; } }
    const body = JSON.stringify(input), path = action === "handoff" && order.kind === "misc" ? "confirm" : action;
    if (attempt.current?.body !== body || attempt.current.action !== action) attempt.current = { body, action, key: createClientRequestId() };
    setBusy(true); setError("");
    try { showUpdatedOrder(await patternRequest(`orders/${orderId}/${path}`, PatternOrderDetailSchema, { method: "POST", body, headers: { "idempotency-key": attempt.current.key } })); }
    catch (e) { setError(e instanceof Error ? e.message : "操作失败"); }
    finally { setBusy(false); }
  };
  const visibleRounds = staleRound||historyRead&&requestedRound ? order?.rounds.filter(round => round.roundId === requestedRound) ?? [] : order?.rounds ?? [];
  const currentRound = order?.rounds.find(round => round.roundId === order.currentRoundId);
  const displayRound = staleRound ? visibleRounds[0] : currentRound;
  const selectedStage = displayRound ? assignmentOnly||inlineExecution?displayRound.status:patternSelectedStage(displayRound, window.location.search) : null;
  const selectedNode = displayRound ? patternWorkflow(displayRound, order?.kind === "misc").find(item => item.stage === selectedStage) : null;
  const readOnlyView=historyRead||Boolean(order?.historicalView);
  const currentWorkspace = !readOnlyView && !staleRound && selectedStage === currentRound?.status;
  const currentParams = new URLSearchParams(window.location.search); currentParams.delete("node"); currentParams.delete("round");currentParams.delete("readOnly");
  const currentHref = `${window.location.pathname}${currentParams.size ? `?${currentParams}` : ""}`;

  const confirmAction = async (action: "complete" | "handoff") => {
    if (busy || !order) return;
    const message = action === "complete" ? "确认本轮工作已完成？" : order.kind === "misc" ? "确认杂事已完成？" : "确认已收到本轮样板？";
    if (await confirmInApp(message)) await act(action);
  };
  useEffect(() => { setHours(currentRound?.segments.at(-1)?.actualHours ?? ""); }, [order?.version, currentRound?.segments]);
  useEffect(()=>{
    if(!order)return;
    const segment=new URLSearchParams(window.location.search).get("segment");
    if(segment&&order.rounds.some(round=>round.segments.some(item=>item.segmentId===segment))) document.getElementById(`segment-${segment}`)?.scrollIntoView({block:"center"});
  },[order]);
  const assignment=order?.actions.assign&&currentWorkspace&&!editing&&!(inlineExecution&&currentRound?.roundType==='initial')?order.developmentSourceId&&currentRound?.roundType!=='rework'?<DevelopmentAssignmentEntry sourceId={order.developmentSourceId} onChanged={()=>{reloadDetail(true);onChanged?.();}}/>:<div className={`pattern-fields pattern-assignment${currentRound?.roundType === "rework" ? " has-rework-price" : ""}`}><label>板房师傅<div className="rework-v2-control"><SearchSelect options={workers.map(worker => ({ value: worker.personId, label: worker.name }))} value={personId} onChange={setPersonId} onSearchChange={setWorkerSearch} placeholder="输入姓名选择师傅" ariaLabel="板房师傅" emptyText="没有匹配的师傅" disabled={busy} /></div></label>{currentRound?.roundType === "rework" ? <InsetField label="本轮返工金额（元）" inputMode="decimal" value={reworkAmount} onChange={e => setReworkAmount(e.target.value)} disabled={busy} /> : null}<div className="rework-v2-actions pattern-single-action"><Button variant="primary" disabled={busy || !personId || (currentRound?.roundType === "rework" && !reworkAmount)} onClick={() => void act("assign")}>{busy ? "提交中…" : assignmentOnly ? "确认分派" : "确认分配"}</Button></div></div>:null;
  if(assignmentOnly)return <section className="pattern-orders pattern-assignment-workspace" aria-label="主管正式派工"><h3>主管正式派工</h3>{displayRound&&<dl className="pattern-assignment-snapshot"><div><dt>本轮品类</dt><dd>{displayRound.categoryName??"未登记"}</dd></div><div><dt>本轮数量</dt><dd>{displayRound.quantity==null?"未登记":formatBusinessDecimal(displayRound.quantity)}</dd></div><div><dt>原执行单价</dt><dd>{displayRound.unitPrice==null?"无可见价格":assignmentMoney(displayRound.unitPrice)}</dd></div><div><dt>原约定金额</dt><dd>{displayRound.agreedAmount==null?"无可见金额":assignmentMoney(displayRound.agreedAmount)}</dd></div></dl>}{error&&<p role="alert">{error}</p>}{error&&!order&&<Button disabled={busy} onClick={()=>void retryDetail()}>重新读取订单</Button>}{!order&&!error&&<p>正在读取待派工资料…</p>}{assignment}{order&&!assignment&&<p>本轮没有可执行的正式派工操作。</p>}</section>;
  return <div className="pattern-orders pattern-detail" data-dx-ui="governed">{!inlineExecution&&<Header title={order ? order.kind === "misc" ? order.taskName ?? "杂事" : order.styleNo : "板房订单"} subtitle={order?.orderNo ?? ""} badge={historyRead||order?.historicalView ? "历史节点 · 只读" : order ? PATTERN_ORDER_STATUS_LABELS[order.status] : "订单打板"} badgePlacement="subtitle" backHref={patternReturnPath(window.location.search)} />}
    {error ? <Surface><p role="alert">{error}</p><Button disabled={busy} onClick={()=>void retryDetail()}>重新读取订单</Button></Surface> : null}
    {!order && !error ? <p role="status">正在读取订单…</p> : null}
    {order ? <>
      {historyRead&&!order.historicalView&&<div className="pattern-history-notice"><span>历史记录 · 只读</span><a href={currentHref}>返回当前订单</a></div>}
      {order.historicalView ? <div className="pattern-history-notice"><span>历史节点 · 只读 · {order.historicalView.actorName} · {patternTime(order.historicalView.at)}</span><a href={currentHref}>返回当前节点</a>{order.historicalView.missingFacts && <p>{order.historicalView.reason??"本次提交的任务资料未完整留存，缺失字段未使用当前资料补齐。"}</p>}</div> : null}
      <Surface className="pattern-order-summary">
        <div className="pattern-summary-core"><dl className="pattern-facts">
          <div><dt>板房师傅</dt><dd>{displayRound?.segments.at(-1)?.workerName ?? order.currentWorkerName ?? (readOnlyView ? "无可见分配记录" : "待分配")}</dd></div>
          <div><dt>要求完成</dt><dd>{order.requiredDate ?? "—"}</dd></div>
          <div><dt>创建人</dt><dd>{order.creatorName}</dd></div>
        </dl>{displayRound && <PatternRoundRecord round={displayRound} misc={order.kind === "misc"} summaryOnly />}</div>
        {(order.kind === "misc" ? order.styleNo : order.customer || order.sizeColor || order.variant || order.referenceStyleNo) ? <dl className="pattern-facts pattern-summary-extra">
          {order.kind === "misc" ? <div><dt>关联款号</dt><dd>{order.association?.label??order.styleNo}</dd></div> : <>
            {order.customer && <div><dt>客户</dt><dd>{order.customer}</dd></div>}
            {order.sizeColor && <div><dt>尺码与颜色</dt><dd>{order.sizeColor}</dd></div>}
            {order.variant && <div><dt>版型</dt><dd>{order.variant}</dd></div>}
            {order.referenceStyleNo && <div><dt>参考历史款号</dt><dd>{order.referenceStyleNo}</dd></div>}
          </>}
        </dl> : null}
        {order.note ? <p className="pattern-note">备注：{order.note}</p> : null}
      </Surface>
      <div className="pattern-detail-overview">
        {order.canReadMaterials !== false && displayRound ? <section className="pattern-material-section"><div className="pattern-section-heading"><h2>制作资料</h2><small>{order.attachments.filter(file => file.roundId === displayRound.roundId && file.active).length} 份</small></div><PatternMaterials files={order.attachments.filter(file => file.roundId === displayRound.roundId && file.active)} /></section> : null}
        {!inlineExecution&&<section className="pattern-flow-section"><details className="pattern-disclosure" open={workflowOpen} onToggle={event => setWorkflowOpen(event.currentTarget.open)}><summary>订单流程{displayRound && <small>{PATTERN_ORDER_STATUS_LABELS[displayRound.status]}</small>}</summary>{displayRound && selectedStage ? <PatternProgress round={displayRound} misc={order.kind === "misc"} selected={selectedStage} search={window.location.search} disabled={busy || editing || exception !== null} /> : null}</details></section>}
      </div>
      <Surface className="pattern-workspace"><section id="pattern-node-workspace" aria-label="节点办理区"><h2>{inlineExecution?"原执行特殊办理":selectedNode?.label ?? "办理区"}{readOnlyView ? " · 历史只读" : ""}</h2>
      {currentWorkspace && !editing ? <>
        {!exception ? assignment : null}
        {!exception && order.actions.hours ? <div><h3>实际工时</h3><p>本轮已保存工时合计：{currentRound?.actualHours ? `${formatBusinessDecimal(currentRound.actualHours, 2)} 小时` : "待填写"}</p><p>保存实际工时只登记工时，不代替工人报完工或发起人确认完成。</p><div className="pattern-fields pattern-hours"><InsetField label="当前执行段实际工时（小时）" type="number" inputMode="decimal" min="0.1" max="999999.9" step="0.1" value={hours} onChange={e => setHours(e.target.value)} disabled={busy} /><div className="rework-v2-actions pattern-single-action"><Button variant="primary" disabled={busy || !hours} onClick={() => void act("hours")}>保存实际工时</Button></div></div></div> : null}
        {order.kind==="misc"&&<p>工人完工、主管工时及本单小时价确定后才具备计薪条件；发起人确认完成用于关闭任务。</p>}<div className="pattern-workspace-actions">{!exception ? <div className="pattern-actions">{order.actions.edit ? <Button disabled={busy} onClick={() => setEditing(true)}>更新任务资料</Button> : null}{!inlineExecution&&order.actions.complete ? <Button variant="primary" disabled={busy} onClick={() => void confirmAction("complete")}>报完工</Button> : null}{!inlineExecution&&order.actions.handoff ? <Button variant="primary" disabled={busy} onClick={() => void confirmAction("handoff")}>{order.kind === "misc" ? "确认完成" : "确认收到样板"}</Button> : null}</div> : null}
        <PatternOrderExceptions developmentContext={developmentContext} order={order} active={exception} onActive={value => { setException(value); }} busy={busy} onBusy={setBusy} onSaved={showUpdatedOrder} /></div>
      </> : null}
      {readOnlyView && displayRound && <div className="pattern-readonly-workspace">
        {selectedStage === "pending_assignment" ? <div className={`pattern-fields pattern-assignment${displayRound.roundType === "rework" ? " has-rework-price" : ""}`}>
          <InsetField label="板房师傅" value={displayRound.segments[0]?.workerName ?? "历史未记录"} readOnly />
          {displayRound.roundType === "rework" && displayRound.agreedAmount !== undefined ? <InsetField label="本轮返工金额（元）" value={displayRound.agreedAmount === null ? "历史未记录" : formatBusinessDecimal(displayRound.agreedAmount, 2)} readOnly /> : null}
        </div> : <>
          <InsetField label="板房师傅" value={displayRound.segments.at(-1)?.workerName ?? "历史未记录"} readOnly />
          {order.kind === "misc" && displayRound.segments.at(-1)?.actualHours !== undefined ? <InsetField label="当前执行段实际工时（小时）" value={displayRound.segments.at(-1)?.actualHours === null ? "当时未填写" : formatBusinessDecimal(displayRound.segments.at(-1)?.actualHours ?? "0", 2)} readOnly /> : null}
          <p>{selectedStage === "in_progress" ? displayRound.completedAt ? "已报完工" : "本次执行已终止" : selectedStage === "pending_confirmation" ? displayRound.handedOverAt ? order.kind === "misc" ? "已确认完成" : "已确认收到样板" : "本次确认未提交" : PATTERN_ORDER_STATUS_LABELS[selectedStage!]}</p>
        </>}
      </div>}
      </section></Surface>
      {currentWorkspace && order.reworkBlockedReason ? <p role="status">{order.reworkBlockedReason}</p> : null}
      {editing && !staleRound && !readOnlyView ? <PatternOrderForm key={order.version} order={order} onCancel={() => setEditing(false)} onSaved={updated => { showUpdatedOrder(updated); setEditing(false); }} /> : null}
      {readOnlyView && displayRound ? <section className="pattern-history-section" aria-label="本节点执行明细">
        <PatternRoundRecord round={displayRound} misc={order.kind === "misc"} omitSummary />
        {order.canReadMaterials !== false && order.attachments.some(file => file.roundId === displayRound.roundId && !file.active) && <section><h3>历史制作资料</h3><PatternMaterials files={order.attachments.filter(file => file.roundId === displayRound.roundId && !file.active)} /></section>}
      </section> : null}
      <section className="pattern-history-section"><details className="pattern-disclosure"><summary>流转用时</summary>
        {visibleRounds.map(round => <section key={round.roundId}>
          {visibleRounds.length > 1 && <h3>{order.kind === "misc" ? "杂事" : round.index === 0 ? "首次打板" : round.index === null ? "返工请求（未派工）" : `第 ${round.index} 次返工`}</h3>}
          <PatternNodeHistory round={round} misc={order.kind === "misc"} />
          {!inlineExecution&&!readOnlyView && <a href={`?${new URLSearchParams({ ...Object.fromEntries(new URLSearchParams(window.location.search)), round: round.roundId, node: round.status === "pending_assignment" ? "pending_assignment" : round.status === "cancelled" ? "cancelled" : round.status === "completed" ? "completed" : "in_progress" })}`}>查看本轮节点明细</a>}
        </section>)}
      </details></section>
    </> : null}
  </div>;
}
