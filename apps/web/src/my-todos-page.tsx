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
import { verifySession } from "./auth.js";
import { Shell } from "./components.js";
import { todoModuleIdsForUser } from "./platform-access.js";
import { todoPageWindow } from "./todo-pagination.js";
import { useDebouncedValue } from "./use-debounced-value.js";
import { readTodoQuery, todoQueryPath, withTodoReturn } from "./todo-query-state.js";
import "./my-todos.css";

const { apiUrl, pageUrl } = createWebUrls(import.meta.env.BASE_URL);

type LoadState =
  | { kind: "loading" }
  | {
      kind: "ready";
      activeModule: TodoModule;
      moduleCounts: TodoModuleCounts;
      page: number;
      pageSize: 15;
      totalCount: number;
      totalPages: number;
      todos: TodoResponse[];
    }
  | { kind: "error"; message: string };

const todoModules: readonly Readonly<{ id: TodoModule; label: string }>[] = [
  { id: "sourcing", label: "外发定价&选厂" },
  { id: "rework", label: "订单返工" },
  { id: "production", label: "实时生产" },
  { id: "samples", label: "样衣管理" },
];

const taskLabel: Record<TodoResponse["route"]["routeName"], string> = {
  rework_detail: "查看返工单",
  process_configuration: "配置或审核返工工序",
  whole_order_review: "审核整张返工单",
  responsibility_detail: "处理责任判定",
  own_factory_approval: "查看历史本厂审批",
  external_responsibility_detail: "记录供应商实际扣款",
  wage_period_detail: "核对返工工资",
  sourcing_detail: "处理外发定价选厂订单",
  production_detail: "查看生产风险",
  sample_detail: "处理样衣事项",
};

const taskTitle = (todo: TodoResponse): string =>
  todo.category === "owner_signature"
    ? "老板确认签字"
    : todo.category === "tail_inspection"
      ? "历史整查报数"
    : todo.category === "external_supplier_selection"
      ? "历史供应商选择"
      : taskLabel[todo.route.routeName];

const categoryLabel = (todo: TodoResponse): string => {
  const labels: Record<string, string> = {
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
    sourcing_management_decision: "生产管理调价选厂",
    sourcing_owner_approval: "老板最终审批",
  };
  return labels[todo.category] ?? taskTitle(todo);
};

const todoHref = (todo: TodoResponse): string => {
  const route = todo.route;
  const orderId = route.reworkOrderId ?? route.entityId;
  const query = new URLSearchParams({ todo: todo.todoId });
  let target: string;
  switch (route.routeName) {
    case "sample_detail":
      target = `ui/samples/${route.entityId}`;
      break;
    case "production_detail":
      target = `ui/production-dashboard/${route.entityId}`;
      break;
    case "process_configuration":
      target = "ui/process-configuration";
      query.set("rework", route.entityId);
      break;
    case "whole_order_review":
      target = "ui/work-reporting";
      query.set("rework", orderId);
      break;
    case "wage_period_detail":
      target = `ui/wages/${route.entityId}`;
      break;
    case "sourcing_detail":
      target = `ui/sourcing/orders/${route.entityId}`;
      break;
    case "responsibility_detail":
    case "own_factory_approval":
    case "external_responsibility_detail":
      target = `ui/tasks/${orderId}`;
      query.set("tab", route.tab ?? route.routeName.replace("_detail", ""));
      break;
    case "rework_detail":
      target = `ui/tasks/${orderId}`;
      if (route.tab) query.set("node", route.tab);
      break;
  }
  return `${pageUrl(target)}?${query.toString()}`;
};

const formatDueAt = (value: string | null): string => {
  if (!value) return "无固定截止时间";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Shanghai",
  }).format(new Date(value));
};

const formatNodeDuration = (value: string): string => {
  const elapsed = Math.max(0, Date.now() - new Date(value).getTime());
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
  const [refresh,setRefresh] = useState(0);
  const [busy, setBusy] = useState(false);
  const [accessibleTodoModules, setAccessibleTodoModules] = useState<ReadonlySet<TodoModule> | null>(null);
  const loadVersion = useRef(0);
  const activeQuery = useDebouncedValue(searchQuery.trim(), 250);

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
    void verifySession(true).then((session) => {
      if (!mounted) return;
      const modules = session !== "denied" && session.status === "authorized"
        ? todoModuleIdsForUser(session.user)
        : [];
      setAccessibleTodoModules(new Set(modules));
      if(session !== "denied" && session.status === "authorized") {
        const savedOwner=window.history.state?.dxTodoQueryUser;
        if(savedOwner && savedOwner!==session.user.id){setSearchQuery("");setRequestedModule(undefined);setRequestedPage(1);}
        setQueryOwner(session.user.id);
      }
    });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    if(queryOwner && activeQuery===searchQuery.trim()) void load(requestedModule, activeQuery, requestedPage, controller.signal);
    return () => controller.abort();
  }, [activeQuery, requestedModule, requestedPage, queryOwner, searchQuery, refresh]);

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
      ++loadVersion.current;setQueryOwner(null);setState({kind:"loading"});
      void verifySession(true).then(session=>{
        if(!mounted)return;
        if(session==="denied"||session.status!=="authorized"||savedOwner!==session.user.id){
          // A different identity must also discard the restored shell/session UI.
          window.location.replace(pageUrl("/ui/my-tasks"));return;
        }
        setAccessibleTodoModules(new Set(todoModuleIdsForUser(session.user)));
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
  const totalActionable = moduleCounts.rework + moduleCounts.sourcing + (moduleCounts.production ?? 0) + (moduleCounts.samples ?? 0);
  const visiblePages = todoPageWindow(page, renderedTotalPages);
  const pageWindowStart = visiblePages[0] ?? 1;
  const pageWindowEnd = visiblePages.at(-1) ?? 1;
  const visibleTodoModules = accessibleTodoModules === null
    ? []
    : todoModules.filter((module) => accessibleTodoModules.has(module.id));

  const openModule = (module: TodoModule): void => {
    setRequestedModule(module);
    setRequestedPage(1);
  };

  return (
    <Shell active="我的待办">
      <div className="my-todos-page" aria-busy={busy}>
        <header className="page-heading my-todos-hero">
          <div className="my-todos-hero__title">
            <h1><NavigationIcon route="/ui/my-tasks" size="title" />我的待办</h1>
            <p>这里只显示现在轮到你处理的事项。</p>
          </div>
          <StatusBadge tone="info">个人任务</StatusBadge>
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
              className={module.id === activeModule ? "is-active" : ""}
              aria-pressed={module.id === activeModule}
              disabled={busy}
              onClick={() => openModule(module.id)}
              key={module.id}
            ><span>{module.label}</span><strong>{formatBusinessDecimal(moduleCounts[module.id] ?? 0)}件</strong></button>)}
          </div>
          <label className="my-todos-search" htmlFor="my-todos-search">
            <input
              id="my-todos-search"
              type="search"
              value={searchQuery}
              maxLength={100}
              aria-label="搜索待办"
              placeholder="输入供应商、款号或跟单姓名，自动筛选"
              autoComplete="off"
              onChange={(event) => {
                setSearchQuery(event.target.value);
                setRequestedPage(1);
              }}
            />
          </label>
        </div>
      {todos.length === 0 && (
        <div className="my-todos-state my-todos-module-empty">
          <p>{activeQuery
            ? "未找到匹配的待办，请检查供应商、款号或跟单姓名。"
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
            const orderSummary = todo.entityType === "sample" ? `样衣：${order?.orderNo ?? ""} · ${order?.styleNo ?? ""}` : (todo.entityType === "sourcing_case" || todo.entityType === "production_order")
              ? `款号：${order?.styleNo ?? "未填写"} · 供应商：${order?.supplierName ?? "待选厂"}`
              : order
                ? `款号：${order.styleNo ?? "未填写"} · 返工单：${order.reworkNo ?? "待生成"}`
                : todo.route.routeName === "wage_period_detail"
                  ? "工资期间核对任务"
                  : "返工单关联信息待读取";
            return (
              <div className="my-todo-card" key={todo.todoId}>
                {blocked ? (
                  <div className="my-todo-row my-todo-row--blocked">
                    <b className="my-todo-index">{String((page - 1) * pageSize + index + 1).padStart(2, "0")}</b>
                    <div className="my-todo-primary">
                      <StatusBadge tone="danger">需要转交</StatusBadge>
                      <h2>{taskTitle(todo)}</h2>
                      <p>{todo.blockedReason ?? "当前任务需要由管理人员转交。"}</p>
                    </div>
                  </div>
                ) : (
                  <a className="my-todo-row" href={withTodoReturn(taskHref(todo),{q:activeQuery,module:activeModule,page})}>
                    <b className="my-todo-index">{String((page - 1) * pageSize + index + 1).padStart(2, "0")}</b>
                    <div className="my-todo-primary">
                      <div className="my-todo-title">
                        <h2>{taskTitle(todo)}</h2>
                        <StatusBadge tone="warning">{todo.unread === undefined ? "待处理" : todo.unread ? "未读" : "已读 · 风险仍在"}</StatusBadge>
                      </div>
                      <p>{orderSummary}</p>
                    </div>
                    <div className="my-todo-metrics" aria-label="待办业务信息">
                      <span><small>当前节点</small>{categoryLabel(todo)}</span>
                      <span><small>{todo.entityType === "production_order" ? "风险持续" : "节点停留"}</small>{formatNodeDuration(todo.createdAt)}</span>
                      {todo.entityType === "production_order" ? <span><small>生产进度</small>{formatBusinessDecimal(todo.productionProgress ?? 0)}%</span> : todo.entityType === "sample" ? null : <span><small>相关金额</small>待核定</span>}
                      <span><small>截止</small>{formatDueAt(todo.dueAt)}</span>
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
          disabled={busy}
          onClick={() => setRequestedPage(1)}
        >1</button>}
        {pageWindowStart > 2 && <span className="my-todos-pagination__ellipsis" aria-hidden="true">…</span>}
        {visiblePages.map((pageNumber) => <button
          type="button"
          className={pageNumber === page ? "is-active" : ""}
          aria-current={pageNumber === page ? "page" : undefined}
          disabled={busy}
          onClick={() => setRequestedPage(pageNumber)}
          key={pageNumber}
        >{pageNumber}</button>)}
        {pageWindowEnd < renderedTotalPages - 1 && <span className="my-todos-pagination__ellipsis" aria-hidden="true">…</span>}
        {pageWindowEnd < renderedTotalPages && <button
          type="button"
          className={page === renderedTotalPages ? "is-active" : ""}
          aria-current={page === renderedTotalPages ? "page" : undefined}
          disabled={busy}
          onClick={() => setRequestedPage(renderedTotalPages)}
        >{renderedTotalPages}</button>}
      </nav>
      </Surface>}
      </div>
    </Shell>
  );
}

