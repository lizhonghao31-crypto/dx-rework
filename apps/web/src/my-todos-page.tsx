import {beginForegroundWait} from './foreground-loading.js';
import {cachedVerifiedSession,refreshSession} from './auth-session.js';
import {subscribeTodoRead} from './todo-indicator-refresh.js';
import {TodoRoutingTransfer} from './todo-routing-transfer.js';
import { todoTaskTitle } from "@dx-rework/contracts";
import { todoRouteHref } from "./todo-route-link.js";
import { NavigationIcon } from "./navigation-icons.js";
import { formatBusinessDecimal } from "@dx-rework/contracts/business-display";
import {
  TodoListResponseSchema,
  type TodoModule,
  type TodoModuleCounts,
  type TodoResponse,
} from "@dx-rework/contracts";
import { Button, StatusBadge, Surface } from "@dx-rework/ui";
import { useEffect, useRef, useState } from "react";

import { createWebUrls } from "../url-contract.js";
import { Shell } from "./components.js";
import { todoModuleIdsForUser } from "./platform-access.js";
import { todoPageWindow } from "./todo-pagination.js";
import { useDebouncedValue } from "./use-debounced-value.js";
import { readTodoQuery, todoQueryPath, withTodoReturn } from "./todo-query-state.js";
import { useInternalReturnScroll } from "./use-internal-return-scroll.js";
import "./my-todos.css";

const { apiUrl, pageUrl } = createWebUrls(import.meta.env.BASE_URL);

type LoadState =
  | { kind: "loading" }
  | {
      kind: "ready";
      activeModule: TodoModule;
      appliedQuery: string;
      moduleCounts: TodoModuleCounts;
      page: number;
      pageSize: 15;
      totalCount: number;
      totalPages: number;
      todos: TodoResponse[];
    }
  | { kind: "error"; message: string };

const todoModules: readonly Readonly<{ id: TodoModule; label: string }>[] = [
  { id: "digital_production", label: "开发与大货" },
  { id: "sourcing", label: "外发定价&选厂" },
  { id: "rework", label: "订单返工" },
  { id: "production", label: "实时生产" },
  { id: "samples", label: "样衣管理" },
  { id: "pattern_room", label: "订单打板" },
  { id: "suppliers", label: "供应商中心" },
];

const taskTitle = todoTaskTitle;

const categoryLabel = (todo: TodoResponse): string => {
  const labels: Record<string, string> = {
    sourcing_price_contract_return: "调价合同待签回",
    sourcing_price_owner_approve: "价格重新申请待审批",
    sourcing_transfer_contract_return: "转厂合同待签回",
    supplier_onboarding_approval: "新增供应商审批",
    supplier_onboarding_return: "修改供应商申请",
    pattern_room_assignment: "分配板房工人",
    pattern_room_execution: "板房制作与报完工",
    pattern_room_handoff: "确认收到样板",
    pattern_room_misc_confirmation: "确认杂事完成",
    pattern_room_hours: "填写杂事实际工时",
    pattern_room_cancel_fees: "确认打板取消费用",
    sample_borrow_confirm: "确认样衣借出",
    sample_return_confirm: "确认样衣归还",
    production_behind: "进度落后",
    production_high_risk: "进度高风险",
    production_stale: `已 ${todo.daysWithoutUpdate ?? 0} 天未更新`,
    process_configuration: "配置返工工序",
    process_configuration_return: "退回重新配置工序",
    process_configuration_rejection_notice: "工序审核退回通知",
    ie_review: "IE 审核",
    task_assignment: "分配返工人员",
    work_reporting: "登记返工完成",
    tail_inspection: "历史整查报数",
    whole_order_review: "整单审核",
    quantity_adjustment: "数量调整审核",
    responsibility_determination: "责任判定与资料核验",
    owner_signature: "老板确认签字",
    own_factory_approval: "历史本厂金额审批",
    external_supplier_selection: "历史供应商选择",
    external_responsibility: "供应商实际扣款",
    wage_review: "返工工资核对",
    sourcing_ie_quote: "IE 给价",
    sourcing_management_decision: "供应链总监调价选厂",
    sourcing_owner_approval: "老板最终审批",
    sourcing_contract_return: "回传合同",
  };
  return labels[todo.category] ?? taskTitle(todo);
};

const todoHref = (todo: TodoResponse): string => todoRouteHref(todo.route);

const formatDueAt = (value: string | null,exclusive=false): string => {
  if (!value) return "无固定截止时间";
  if(exclusive)return new Intl.DateTimeFormat("zh-CN",{month:"2-digit",day:"2-digit",timeZone:"Asia/Shanghai"}).format(new Date(Date.parse(value)-1))+" 当天结束";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Shanghai",
  }).format(new Date(value));
};

const formatNodeDuration = (value: string,timing?:TodoResponse["timing"]): string => {
  if(timing?.status==="unlimited")return "不单独计时";
  if(timing&&timing.elapsedSeconds===null)return "开始时间未知";
  const elapsed = timing?timing.elapsedSeconds!*1000:Math.max(0, Date.now() - new Date(value).getTime());
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时 ${minutes % 60} 分`;
  return `${Math.floor(hours / 24)} 天 ${hours % 24} 小时`;
};

const taskHref = (todo: TodoResponse): string => [
  "process_configuration",
  "whole_order_review",
  "responsibility_detail",
  "own_factory_approval",
  "external_responsibility_detail",
  "wage_period_detail",
].includes(todo.route.routeName)
  ? pageUrl(`ui/my-tasks/${todo.todoId}`)
  : todoHref(todo);

export function MyTodosPage() {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [initial] = useState(()=>readTodoQuery(window.location.search));
  const [searchQuery, setSearchQuery] = useState(initial.q);
  const [requestedModule, setRequestedModule] = useState<TodoModule | undefined>(initial.module);
  const [requestedPage, setRequestedPage] = useState(initial.page);
  const [queryOwner,setQueryOwner] = useState<string | null>(null);
  const [readIndicator,setReadIndicator]=useState<{actorId:string;count:number}|null>(null);
  const unreadCount=readIndicator?.actorId===queryOwner?readIndicator.count:null;
  useEffect(()=>{const receive=(event:Event)=>{const detail=(event as CustomEvent<{actorId:string;unreadCount?:number}>).detail,session=cachedVerifiedSession();if(session&&session!=='denied'&&detail?.actorId===session.user.id)setReadIndicator(detail.unreadCount===undefined?null:{actorId:detail.actorId,count:detail.unreadCount});};window.addEventListener('dx-rework:todo-refresh',receive);return()=>window.removeEventListener('dx-rework:todo-refresh',receive);},[]);
  const [refresh,setRefresh] = useState(0);
  const running=useRef<{controller:AbortController;refreshOnSettle:boolean}|null>(null);
  const lastTarget=useRef<string|null>(null);
  useEffect(()=>subscribeTodoRead(()=>{
    if(running.current)running.current.refreshOnSettle=true;
    else setRefresh(value=>value+1);
  }),[]);
  const [routingAccess,setRoutingAccess]=useState({manage:false});
  const [busy, setBusy] = useState(false);
  const [accessibleTodoModules, setAccessibleTodoModules] = useState<ReadonlySet<TodoModule> | null>(null);
  const loadVersion = useRef(0);
  const activeQuery = useDebouncedValue(searchQuery.trim(), 250);
  const searchReady=activeQuery===searchQuery.trim();
  const displayedQuery=state.kind==="ready"?state.appliedQuery:activeQuery;
  useInternalReturnScroll(state.kind === "ready" && !busy);

  const load = async (
    module: TodoModule | undefined,
    query: string,
    page: number,
    signal?: AbortSignal,
  ): Promise<void> => {
    const version = ++loadVersion.current;
    setBusy(true);
    try {
      const params = new URLSearchParams({ q: query, page: String(page) });
      if (module) params.set("module", module);
      const response = await fetch(`${apiUrl("todos/mine")}?${params.toString()}`, {
        credentials: "include",
        headers: { accept: "application/json" },
        ...(signal ? { signal } : {}),
      });
      if (!response.ok) throw new Error(`待办加载失败（${response.status}）`);
      const result = TodoListResponseSchema.parse(await response.json());
      if (version !== loadVersion.current || signal?.aborted) return;
      window.history.replaceState({...window.history.state,dxTodoQueryUser:queryOwner},"",pageUrl(todoQueryPath({q:query,module:result.activeModule,page:result.page})));
      setState({
        kind: "ready",
        activeModule: result.activeModule,
        appliedQuery:query,
        moduleCounts: result.moduleCounts,
        page: result.page,
        pageSize: result.pageSize,
        totalCount: result.totalCount,
        totalPages: result.totalPages,
        todos: result.todos,
      });
    } catch (error: unknown) {
      if (signal?.aborted || version !== loadVersion.current) return;
      setState({ kind: "error", message: error instanceof Error ? error.message : "待办加载失败" });
    } finally {
      if (version === loadVersion.current) setBusy(false);
    }
  };

  useEffect(() => {
    let mounted = true;
    void refreshSession().then((session) => {
      if (!mounted) return;
      const modules = session !== "denied" && session.status === "authorized"
        ? todoModuleIdsForUser(session.user)
        : [];
      setAccessibleTodoModules(new Set(modules));
      if(session !== "denied" && session.status === "authorized") {
        const savedOwner=window.history.state?.dxTodoQueryUser;
        if(savedOwner && savedOwner!==session.user.id){setSearchQuery("");setRequestedModule(undefined);setRequestedPage(1);}
        setRoutingAccess({manage:session.user.businessRoles?.includes('production_management')===true&&session.user.capabilities.includes('todo:routing_exception_manage')});
        setQueryOwner(session.user.id);
      }
    });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if(!queryOwner||!searchReady){setBusy(false);return;}
    const controller = new AbortController(),work={controller,refreshOnSettle:false};
    const target=JSON.stringify([queryOwner,requestedModule,activeQuery,requestedPage]);
    const finish=target===lastTarget.current?()=>{}:beginForegroundWait();
    running.current=work;
    void load(requestedModule,activeQuery,requestedPage,controller.signal).finally(()=>{
      finish();
      if(running.current!==work)return;
      if(!controller.signal.aborted)lastTarget.current=target;
      running.current=null;
      if(work.refreshOnSettle)setRefresh(value=>value+1);
    });
    return()=>{
      finish();controller.abort();
      if(running.current===work)running.current=null;
    };
  }, [activeQuery, requestedModule, requestedPage, queryOwner, searchReady, refresh]);

  useEffect(()=>{
    if(!queryOwner)return;
    const path=todoQueryPath({q:searchQuery,...(requestedModule?{module:requestedModule}:{}),page:requestedPage});
    window.history.replaceState({...window.history.state,dxTodoQueryUser:queryOwner},"",pageUrl(path));
  },[searchQuery,requestedModule,requestedPage,queryOwner]);
  useEffect(()=>{
    let mounted=true;
    const restored=(event:PageTransitionEvent)=>{
      if(!event.persisted)return;
      const savedOwner=window.history.state?.dxTodoQueryUser;
      ++loadVersion.current;running.current?.controller.abort();lastTarget.current=null;setQueryOwner(null);setState({kind:"loading"});
      void refreshSession().then(session=>{
        if(!mounted)return;
        if(session==="denied"||session.status!=="authorized"||savedOwner!==session.user.id){
          // A different identity must also discard the restored shell/session UI.
          window.location.replace(pageUrl("/ui/my-tasks"));return;
        }
        setAccessibleTodoModules(new Set(todoModuleIdsForUser(session.user)));
        setRoutingAccess({manage:session.user.businessRoles?.includes('production_management')===true&&session.user.capabilities.includes('todo:routing_exception_manage')});
        setQueryOwner(session.user.id);setRefresh(n=>n+1);
      });
    };
    window.addEventListener("pageshow",restored);return()=>{mounted=false;window.removeEventListener("pageshow",restored);};
  },[]);

  const activeModule = state.kind === "ready" ? state.activeModule : "rework";
  const moduleCounts = state.kind === "ready"
    ? state.moduleCounts
    : { rework: 0, sourcing: 0 };
  const todos = state.kind === "ready" ? state.todos : [];
  const page = state.kind === "ready" ? state.page : requestedPage;
  const pageSize = state.kind === "ready" ? state.pageSize : 15;
  const totalPages = state.kind === "ready" ? state.totalPages : 0;
  const renderedTotalPages = Math.max(totalPages, 1);
  const totalActionable = moduleCounts.rework + moduleCounts.sourcing + (moduleCounts.production ?? 0) + (moduleCounts.samples ?? 0) + (moduleCounts.pattern_room ?? 0) + (moduleCounts.suppliers ?? 0) + (moduleCounts.digital_production ?? 0);
  const visiblePages = todoPageWindow(page, renderedTotalPages);
  const pageWindowStart = visiblePages[0] ?? 1;
  const pageWindowEnd = visiblePages.at(-1) ?? 1;
  const visibleTodoModules = accessibleTodoModules === null
    ? []
    : todoModules.filter((module) => module.id === "digital_production" ? moduleCounts.digital_production !== undefined : accessibleTodoModules.has(module.id));

  const openModule = (module: TodoModule): void => {
    setSearchQuery("");
    setRequestedModule(module);
    setRequestedPage(1);
  };

  return (
    <Shell key={queryOwner??"pending-personal-session"} active="我的待办">
      <div className="my-todos-page" aria-busy={busy}>
        <header className="page-heading my-todos-hero">
          <div className="my-todos-hero__title">
            <h1><NavigationIcon route="/ui/my-tasks" size="title" />我的待办</h1>
            <div className="my-todos-intro"><p>这里只显示现在轮到你处理的事项。</p>
          <label className="my-todos-search" htmlFor="my-todos-search">
            <input
              id="my-todos-search"
              type="search"
              value={searchQuery}
              maxLength={100}
              aria-label="搜索全部待办"
              placeholder="搜索全部待办：款号、供应商、跟单或事项"
              autoComplete="off"
              onChange={(event) => {
                setSearchQuery(event.target.value);
                setRequestedPage(1);
              }}
            />
          </label>
</div>
          </div>
          <div><StatusBadge tone="info">个人任务</StatusBadge>{unreadCount!==null&&<p aria-live="polite">开发与大货、生产风险未读：{formatBusinessDecimal(unreadCount)} 项</p>}</div>
        </header>
      {state.kind === "loading" && <Surface className="my-todos-state"><p>正在加载你的待办…</p></Surface>}
      {state.kind === "error" && (
        <Surface className="my-todos-state">
          <StatusBadge tone="danger">加载失败</StatusBadge>
          <p>{state.message}</p>
          <Button onClick={() => window.location.reload()}>重新加载</Button>
        </Surface>
      )}
      {state.kind === "ready" && <Surface className="my-todos-workspace">
        <div className="my-todos-toolbar">
          <div className="my-todos-modules" role="group" aria-label="待办模块">
            {visibleTodoModules.map((module) => <button
              type="button"
              className={!displayedQuery && module.id === activeModule ? "is-active" : ""}
              aria-pressed={!displayedQuery && module.id === activeModule}
              disabled={busy&&module.id===requestedModule&&!searchQuery.trim()}
              onClick={() => openModule(module.id)}
              key={module.id}
            ><span>{module.label}</span><strong>{formatBusinessDecimal(moduleCounts[module.id] ?? 0)}件</strong></button>)}
          </div>

        </div>
      {todos.length === 0 && (
        <div className="my-todos-state my-todos-module-empty">
          <p>{displayedQuery
            ? "未找到匹配的待办，请检查款号、供应商、跟单或事项名称。"
            : totalActionable === 0
              ? "您当前的任务已全部完成。有新的事项轮到你处理时，会出现在这里。"
              : "该模块当前没有待处理事项。"}</p>
        </div>
      )}
      {todos.length > 0 && (
        <div className="my-todos-list">
          {todos.map((todo, index) => {
            const blocked = todo.status === "blocked_recipient";
            const order = todo.orderContext;
            const orderSummary = todo.route.contractReturn
              ? `款号：${order?.styleNo ?? "未填写"} · 加工厂：${todo.route.contractReturn.supplierName} · 调价合同 V${todo.route.contractReturn.version}`
              : todo.route.transferContract
              ? `款号：${order?.styleNo ?? "未填写"} · 新加工厂：${todo.route.transferContract.supplierName} · 合同 V${todo.route.transferContract.version}`
              : todo.entityType === "digital_task" ? `款号：${order?.styleNo ?? "未记录"}${todo.route.developmentRound?` · 第${todo.route.developmentRound}轮`:""}${order?.poNumbers?.length?` · PO：${order.poNumbers.join("、")}`:""}` : todo.entityType === "supplier_onboarding" ? `供应商：${order?.supplierName ?? ""}` : todo.entityType === "pattern_room_order" ? `板房订单：${order?.orderNo ?? ""} · ${order?.styleNo ?? ""}` : todo.entityType === "sample" ? `样衣：${order?.orderNo ?? ""} · ${order?.styleNo ?? ""}` : (todo.entityType === "sourcing_case" || todo.entityType === "production_order")
              ? `款号：${order?.styleNo ?? "未填写"} · 供应商：${order?.supplierName ?? "待选厂"}`
              : order
                ? `款号：${order.styleNo ?? "未填写"} · 返工单：${order.reworkNo ?? "待生成"}`
                : todo.route.routeName === "wage_period_detail"
                  ? "工资期间核对任务"
                  : "返工单关联信息待读取";
            return (
              <div className="my-todo-card" key={todo.todoId}>
                {todo.todoType==='recipient_routing_exception'&&todo.category==='recipient_routing_exception'&&todo.sourceAction==='todo.recipient_blocked' ? <div className="my-todo-row"><b className="my-todo-index">{String((page-1)*pageSize+index+1).padStart(2,'0')}</b><div className="my-todo-primary"><div className="my-todo-title"><h2>待办接手安排</h2><StatusBadge tone="warning">需要转交</StatusBadge></div><p>{orderSummary}</p><TodoRoutingTransfer key={`${queryOwner}:${todo.todoId}`} todo={todo} canManage={routingAccess.manage} onChanged={()=>setRefresh(value=>value+1)}/></div></div> : blocked ? (
                  <div className="my-todo-row my-todo-row--blocked">
                    <b className="my-todo-index">{String((page - 1) * pageSize + index + 1).padStart(2, "0")}</b>
                    <div className="my-todo-primary">
                      <StatusBadge tone="danger">需要转交</StatusBadge>
                      <h2>{taskTitle(todo)}</h2>
                      <p>{todo.blockedReason ?? "当前任务需要由管理人员转交。"}</p>
                      {todo.entityType==="digital_task"&&todo.category==="digital_assignment"&&order?.styleNo&&<><p>{orderSummary}</p><a href={withTodoReturn(taskHref(todo),{q:displayedQuery,module:activeModule,page})}>查看任务与人员安排</a></>}
                    </div>
                  </div>
                ) : (
                  <a className="my-todo-row" href={withTodoReturn(taskHref(todo),{q:displayedQuery,module:activeModule,page})}>
                    <b className="my-todo-index">{String((page - 1) * pageSize + index + 1).padStart(2, "0")}</b>
                    <div className="my-todo-primary">
                      <div className="my-todo-title">
                        <h2>{taskTitle(todo)}</h2>
                        {todo.timing&&<StatusBadge tone={todo.timing.status==="overdue"?"danger":todo.timing.status==="warning"?"warning":"neutral"}>{({overdue:"逾期",warning:"临期",normal:"时效正常",unknown:"时效未定",unlimited:"无独立时限"})[todo.timing.status]}</StatusBadge>}
                        <StatusBadge tone="warning">{todo.unread === undefined ? "待处理" : todo.unread ? "未读" : todo.entityType==="production_order" ? "已读 · 风险仍在" : "已读"}</StatusBadge>
                      </div>
                      <p>{orderSummary}</p>{todo.timing?.reason&&<small>{todo.timing.reason}</small>}
                    </div>
                    <div className="my-todo-metrics" aria-label="待办业务信息">
                      <span><small>当前节点</small>{categoryLabel(todo)}</span>
                      <span><small>{todo.entityType === "production_order" ? "风险持续" : "节点停留"}</small>{formatNodeDuration(todo.createdAt,todo.timing)}</span>
                      {todo.entityType === "production_order" ? <span><small>生产进度</small>{formatBusinessDecimal(todo.productionProgress ?? 0)}%</span> : ["sample", "pattern_room_order", "supplier_onboarding", "digital_task"].includes(todo.entityType) ? null : <span><small>相关金额</small>待核定</span>}
                      <span><small>截止</small>{["sourcing_contract_return","sourcing_transfer_contract_return","sourcing_price_contract_return"].includes(todo.category) ? "见订单回签状态" : formatDueAt(todo.dueAt,todo.timing?.exclusive)}</span>
                    </div>
                  </a>
                )}
              </div>
            );
          })}
        </div>
      )}
      <nav className="my-todos-pagination" aria-label="待办列表分页">
        {pageWindowStart > 1 && <button
          type="button"
          className={page === 1 ? "is-active" : ""}
          aria-current={page === 1 ? "page" : undefined}
          disabled={busy&&requestedPage===1}
          onClick={() => setRequestedPage(1)}
        >1</button>}
        {pageWindowStart > 2 && <span className="my-todos-pagination__ellipsis" aria-hidden="true">…</span>}
        {visiblePages.map((pageNumber) => <button
          type="button"
          className={pageNumber === page ? "is-active" : ""}
          aria-current={pageNumber === page ? "page" : undefined}
          disabled={busy&&requestedPage===pageNumber}
          onClick={() => setRequestedPage(pageNumber)}
          key={pageNumber}
        >{pageNumber}</button>)}
        {pageWindowEnd < renderedTotalPages - 1 && <span className="my-todos-pagination__ellipsis" aria-hidden="true">…</span>}
        {pageWindowEnd < renderedTotalPages && <button
          type="button"
          className={page === renderedTotalPages ? "is-active" : ""}
          aria-current={page === renderedTotalPages ? "page" : undefined}
          disabled={busy&&requestedPage===renderedTotalPages}
          onClick={() => setRequestedPage(renderedTotalPages)}
        >{renderedTotalPages}</button>}
      </nav>
      </Surface>}
      </div>
    </Shell>
  );
}
