import { TodoListResponseSchema, type TodoResponse } from "@dx-rework/contracts";
import { Button, StatusBadge, Surface } from "@dx-rework/ui";
import { useEffect, useMemo, useState } from "react";

import { createWebUrls } from "../url-contract.js";
import { Shell } from "./components.js";
import "./my-todos.css";

const { apiUrl, pageUrl } = createWebUrls(import.meta.env.BASE_URL);

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; todos: TodoResponse[] }
  | { kind: "error"; message: string };

const taskLabel: Record<TodoResponse["route"]["routeName"], string> = {
  rework_detail: "查看返工单",
  process_configuration: "配置或审核返工工序",
  whole_order_review: "审核整张返工单",
  responsibility_detail: "确认责任分配",
  own_factory_approval: "审批本厂承担金额",
  external_responsibility_detail: "处理供应商扣款",
  wage_period_detail: "核对返工工资",
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
    case "responsibility_detail":
    case "own_factory_approval":
    case "external_responsibility_detail":
      target = `ui/tasks/${orderId}`;
      query.set("tab", route.tab ?? route.routeName.replace("_detail", ""));
      break;
    case "rework_detail":
      target = `ui/tasks/${orderId}`;
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

  useEffect(() => {
    const controller = new AbortController();
    void fetch(apiUrl("todos/mine"), {
      credentials: "include",
      headers: { accept: "application/json" },
      signal: controller.signal,
    }).then(async (response) => {
      if (!response.ok) throw new Error(`待办加载失败（${response.status}）`);
      const result = TodoListResponseSchema.parse(await response.json());
      setState({ kind: "ready", todos: result.todos });
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      setState({ kind: "error", message: error instanceof Error ? error.message : "待办加载失败" });
    });
    return () => controller.abort();
  }, []);

  const actionable = useMemo(() => state.kind === "ready"
    ? state.todos.filter((todo) =>
        todo.todoType !== "information"
        && (todo.status === "pending" || todo.status === "blocked_recipient"))
    : [], [state]);

  return (
    <Shell active="我的待办">
      <div className="my-todos-page">
        <div className="my-todos-hero">
          <div className="my-todos-hero__title">
            <h1>我的待办</h1>
            <StatusBadge tone="info">个人任务</StatusBadge>
          </div>
          <p>这里只显示现在轮到你处理的事项。</p>
        </div>
      {state.kind === "loading" && <Surface className="my-todos-state"><p>正在加载你的待办…</p></Surface>}
      {state.kind === "error" && (
        <Surface className="my-todos-state">
          <StatusBadge tone="danger">加载失败</StatusBadge>
          <p>{state.message}</p>
          <Button onClick={() => window.location.reload()}>重新加载</Button>
        </Surface>
      )}
      {state.kind === "ready" && actionable.length === 0 && (
        <Surface className="my-todos-state my-todos-complete">
          <StatusBadge tone="success">当前无待办</StatusBadge>
          <h2>您当前的任务已全部完成，谢谢。</h2>
          <p>有新的事项轮到你处理时，会出现在这里。</p>
        </Surface>
      )}
      {actionable.length > 0 && (
        <div className="my-todos-list">
          {actionable.map((todo, index) => {
            const blocked = todo.status === "blocked_recipient";
            const order = todo.orderContext;
            const orderSummary = order
              ? `${order.reworkNo ?? "返工单号待生成"} · 订单号：${order.orderNo ?? "未填写"} · 款号：${order.styleNo ?? "未填写"}`
              : todo.route.routeName === "wage_period_detail"
                ? "工资期间核对任务"
                : "返工单关联信息待读取";
            return (
              <Surface className="my-todo-card" key={todo.todoId}>
                {blocked ? (
                  <div className="my-todo-row my-todo-row--blocked">
                    <b className="my-todo-index">{String(index + 1).padStart(2, "0")}</b>
                    <div className="my-todo-primary">
                      <StatusBadge tone="danger">需要转交</StatusBadge>
                      <h2>{taskLabel[todo.route.routeName]}</h2>
                      <p>{todo.blockedReason ?? "当前任务需要由管理人员转交。"}</p>
                    </div>
                  </div>
                ) : (
                  <a className="my-todo-row" href={taskHref(todo)}>
                    <b className="my-todo-index">{String(index + 1).padStart(2, "0")}</b>
                    <div className="my-todo-primary">
                      <div className="my-todo-title">
                        <h2>{taskLabel[todo.route.routeName]}</h2>
                        <StatusBadge tone="warning">待处理</StatusBadge>
                      </div>
                      <p>{orderSummary}</p>
                    </div>
                    <div className="my-todo-metrics" aria-label="待办业务信息">
                      <span><small>当前节点</small>{todo.category}</span>
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
      </div>
    </Shell>
  );
}
