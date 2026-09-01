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
import "./my-todos.css";

const { apiUrl, pageUrl } = createWebUrls(import.meta.env.BASE_URL);

type LoadState =
  | { kind: "loading" }
  | {
      kind: "ready";
      activeModule: TodoModule;
      moduleCounts: TodoModuleCounts;
      nextCursor: string | null;
      todos: TodoResponse[];
    }
  | { kind: "error"; message: string };

const todoModules: readonly Readonly<{ id: TodoModule; label: string }>[] = [
  { id: "rework", label: "订单返工" },
  { id: "sourcing", label: "外发定价&选厂" },
  { id: "wages", label: "返工工资" },
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
  const [searchQuery, setSearchQuery] = useState("");
  const [activeQuery, setActiveQuery] = useState("");
  const [cursor, setCursor] = useState("");
  const [cursorHistory, setCursorHistory] = useState<readonly string[]>([]);
  const [busy, setBusy] = useState(false);
  const loadVersion = useRef(0);

  const load = async (
    module: TodoModule | undefined,
    query: string,
    pageCursor: string,
    signal?: AbortSignal,
  ): Promise<void> => {
    const version = ++loadVersion.current;
    setBusy(true);
    try {
      const params = new URLSearchParams({ q: query });
      if (module) params.set("module", module);
      if (pageCursor) params.set("cursor", pageCursor);
      const response = await fetch(`${apiUrl("todos/mine")}?${params.toString()}`, {
        credentials: "include",
        headers: { accept: "application/json" },
        ...(signal ? { signal } : {}),
      });
      if (!response.ok) throw new Error(`待办加载失败（${response.status}）`);
      const result = TodoListResponseSchema.parse(await response.json());
      if (version !== loadVersion.current) return;
      setState({
        kind: "ready",
        activeModule: result.activeModule,
        moduleCounts: result.moduleCounts,
        nextCursor: result.nextCursor,
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
    const controller = new AbortController();
    void load(undefined, "", "", controller.signal);
    return () => controller.abort();
  }, []);

  const activeModule = state.kind === "ready" ? state.activeModule : "rework";
  const moduleCounts = state.kind === "ready"
    ? state.moduleCounts
    : { rework: 0, sourcing: 0, wages: 0 };
  const todos = state.kind === "ready" ? state.todos : [];
  const nextCursor = state.kind === "ready" ? state.nextCursor : null;
  const totalActionable = moduleCounts.rework + moduleCounts.sourcing + moduleCounts.wages;

  const resetPage = (): void => {
    setCursor("");
    setCursorHistory([]);
  };

  const openModule = (module: TodoModule): void => {
    resetPage();
    void load(module, activeQuery, "");
  };

  const searchFromFirstPage = (): void => {
    const query = searchQuery.trim();
    setActiveQuery(query);
    resetPage();
    void load(activeModule, query, "");
  };

  const clearSearch = (): void => {
    setSearchQuery("");
    setActiveQuery("");
    resetPage();
    void load(activeModule, "", "");
  };

  const goToNextPage = (): void => {
    if (!nextCursor || busy) return;
    setCursorHistory((current) => [...current, cursor]);
    setCursor(nextCursor);
    void load(activeModule, activeQuery, nextCursor);
  };

  const goToPreviousPage = (): void => {
    if (cursorHistory.length === 0 || busy) return;
    const previousCursor = cursorHistory[cursorHistory.length - 1] ?? "";
    setCursorHistory((current) => current.slice(0, -1));
    setCursor(previousCursor);
    void load(activeModule, activeQuery, previousCursor);
  };

  return (
    <Shell active="我的待办">
      <div className="my-todos-page" aria-busy={busy}>
        <header className="page-heading my-todos-hero">
          <div className="my-todos-hero__title">
            <h1>我的待办</h1>
            <p>这里只显示现在轮到你处理的事项。</p>
          </div>
          <StatusBadge tone="info">个人任务</StatusBadge>
        </header>
      {state.kind === "ready" && totalActionable > 0 && <nav className="my-todos-modules" aria-label="待办模块">
        {todoModules.map((module) => <button
          type="button"
          className={module.id === activeModule ? "is-active" : ""}
          aria-current={module.id === activeModule ? "page" : undefined}
          disabled={busy}
          onClick={() => openModule(module.id)}
          key={module.id}
        ><span>{module.label}</span><strong>{moduleCounts[module.id]}件</strong></button>)}
      </nav>}
      {state.kind === "ready" && totalActionable > 0 && (
        <form className="my-todos-search" onSubmit={(event) => { event.preventDefault(); searchFromFirstPage(); }}>
          <label htmlFor="my-todos-search">搜索待办</label>
          <input
            id="my-todos-search"
            type="search"
            value={searchQuery}
            placeholder="输入供应商名称或款号"
            autoComplete="off"
            onChange={(event) => setSearchQuery(event.target.value)}
          />
          <button type="submit" disabled={busy}>搜索</button>
          {searchQuery && <button type="button" disabled={busy} onClick={clearSearch}>清除</button>}
        </form>
      )}
      {state.kind === "loading" && <Surface className="my-todos-state"><p>正在加载你的待办…</p></Surface>}
      {state.kind === "error" && (
        <Surface className="my-todos-state">
          <StatusBadge tone="danger">加载失败</StatusBadge>
          <p>{state.message}</p>
          <Button onClick={() => window.location.reload()}>重新加载</Button>
        </Surface>
      )}
      {state.kind === "ready" && totalActionable === 0 && (
        <Surface className="my-todos-state my-todos-complete">
          <StatusBadge tone="success">当前无待办</StatusBadge>
          <h2>您当前的任务已全部完成，谢谢。</h2>
          <p>有新的事项轮到你处理时，会出现在这里。</p>
        </Surface>
      )}
      {state.kind === "ready" && totalActionable > 0 && todos.length === 0 && (
        <Surface className="my-todos-state my-todos-module-empty">
          <p>{activeQuery
            ? "未找到匹配的待办，请检查供应商名称或款号。"
            : "该模块当前没有待处理事项。"}</p>
        </Surface>
      )}
      {todos.length > 0 && (
        <div className="my-todos-list">
          {todos.map((todo, index) => {
            const blocked = todo.status === "blocked_recipient";
            const order = todo.orderContext;
            const orderSummary = todo.entityType === "sourcing_case"
              ? `款号：${order?.styleNo ?? "未填写"} · 供应商：${order?.supplierName ?? "待选厂"}`
              : order
                ? `款号：${order.styleNo ?? "未填写"} · 返工单：${order.reworkNo ?? "待生成"}`
                : todo.route.routeName === "wage_period_detail"
                  ? "工资期间核对任务"
                  : "返工单关联信息待读取";
            return (
              <Surface className="my-todo-card" key={todo.todoId}>
                {blocked ? (
                  <div className="my-todo-row my-todo-row--blocked">
                    <b className="my-todo-index">{String(cursorHistory.length * 15 + index + 1).padStart(2, "0")}</b>
                    <div className="my-todo-primary">
                      <StatusBadge tone="danger">需要转交</StatusBadge>
                      <h2>{taskTitle(todo)}</h2>
                      <p>{todo.blockedReason ?? "当前任务需要由管理人员转交。"}</p>
                    </div>
                  </div>
                ) : (
                  <a className="my-todo-row" href={taskHref(todo)}>
                    <b className="my-todo-index">{String(cursorHistory.length * 15 + index + 1).padStart(2, "0")}</b>
                    <div className="my-todo-primary">
                      <div className="my-todo-title">
                        <h2>{taskTitle(todo)}</h2>
                        <StatusBadge tone="warning">待处理</StatusBadge>
                      </div>
                      <p>{orderSummary}</p>
                    </div>
                    <div className="my-todo-metrics" aria-label="待办业务信息">
                      <span><small>当前节点</small>{categoryLabel(todo)}</span>
                      <span><small>节点停留</small>{formatNodeDuration(todo.createdAt)}</span>
                      <span><small>相关金额</small>待核定</span>
                      <span><small>截止</small>{formatDueAt(todo.dueAt)}</span>
                    </div>
                  </a>
                )}
              </Surface>
            );
          })}
        </div>
      )}
      {todos.length > 0 && <nav className="my-todos-pagination" aria-label="待办列表分页">
        <button type="button" disabled={busy || cursorHistory.length === 0} onClick={goToPreviousPage}>上一页</button>
        <span>第 {cursorHistory.length + 1} 页 · 每页 15 条</span>
        <button type="button" disabled={busy || !nextCursor} onClick={goToNextPage}>下一页</button>
      </nav>}
      </div>
    </Shell>
  );
}
