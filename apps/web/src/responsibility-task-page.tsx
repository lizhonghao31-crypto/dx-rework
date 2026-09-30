import { TodoResponseSchema, type TodoResponse } from "@dx-rework/contracts";
import { StatusBadge, Surface } from "@dx-rework/ui";
import { useCallback, useEffect, useState } from "react";

import { createWebUrls } from "../url-contract.js";
import { todoReturnPath } from "./todo-query-state.js";
import { Header, Shell } from "./components.js";
import { ReworkDetailPage, type WorkflowNodeKey } from "./rework-detail-page.js";
import { WagePeriodDetailPage } from "./wages/wage-period-detail.js";

const { apiUrl } = createWebUrls(import.meta.env.BASE_URL);
type TaskRouteName =
  | "process_configuration"
  | "whole_order_review"
  | "responsibility_detail"
  | "own_factory_approval"
  | "external_responsibility_detail"
  | "wage_period_detail";
type OrderTaskRouteName = Exclude<TaskRouteName, "wage_period_detail">;

type ActionTodo = TodoResponse & {
  route: TodoResponse["route"] & { routeName: TaskRouteName };
};

type State =
  | { kind: "loading" }
  | { kind: "ready"; todo: ActionTodo }
  | { kind: "completed"; todo: ActionTodo }
  | { kind: "blocked"; reason: string }
  | { kind: "error"; message: string };

const workflowNodeByRoute: Record<OrderTaskRouteName, WorkflowNodeKey> = {
  process_configuration: "process_configuration",
  whole_order_review: "whole_order_review",
  responsibility_detail: "responsibility",
  // Kept only so historic, completed todo links remain readable.  New orders
  // never create these approval steps; N07 is the owner signature node.
  own_factory_approval: "settlement_ledger",
  external_responsibility_detail: "settlement_followup",
};

const workflowNodeForTodo = (todo: ActionTodo): WorkflowNodeKey => {
  if (todo.category === "owner_signature") return "owner_signature";
  return workflowNodeByRoute[todo.route.routeName as OrderTaskRouteName];
};

const todoIdFromLocation = (): string | null => {
  const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
  const path = window.location.pathname.startsWith(basePath)
    ? window.location.pathname.slice(basePath.length) || "/"
    : window.location.pathname;
  return path.match(/^\/ui\/my-tasks\/([0-9a-f-]{36})$/i)?.[1] ?? null;
};

const isActionTodo = (todo: TodoResponse): todo is ActionTodo => [
  "process_configuration",
  "whole_order_review",
  "responsibility_detail",
  "own_factory_approval",
  "external_responsibility_detail",
  "wage_period_detail",
].includes(todo.route.routeName);

const focusedExternalCaseId = (todo: ActionTodo): string | undefined =>
  todo.route.routeName === "external_responsibility_detail"
  && todo.category !== "external_supplier_selection"
    ? todo.route.entityId
    : undefined;

export function ResponsibilityTaskPage() {
  const todoId = todoIdFromLocation();
  const [state, setState] = useState<State>({ kind: "loading" });

  const load = useCallback(async (signal?: AbortSignal): Promise<void> => {
    if (!todoId) {
      setState({ kind: "error", message: "任务链接无效" });
      return;
    }
    const response = await fetch(apiUrl(`todos/mine/${todoId}`), {
      credentials: "include",
      headers: { accept: "application/json" },
      ...(signal ? { signal } : {}),
    });
    if (response.status === 404) {
      setState({ kind: "error", message: "该任务已不再分配给你，请返回我的待办查看当前任务。" });
      return;
    }
    if (!response.ok) throw new Error(`任务加载失败（${response.status}）`);
    const todo = TodoResponseSchema.parse(await response.json());
    if (!isActionTodo(todo)) {
      setState({ kind: "error", message: "该任务暂不支持独立处理，请返回我的待办。" });
      return;
    }
    if (todo.status === "completed" || todo.status === "cancelled") {
      setState({ kind: "completed", todo });
      return;
    }
    if (todo.status === "blocked_recipient") {
      setState({ kind: "blocked", reason: todo.blockedReason ?? "当前任务需要由管理人员转交。" });
      return;
    }
    setState({ kind: "ready", todo });
  }, [todoId]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal).catch((error: unknown) => {
      if (!controller.signal.aborted) {
        setState({ kind: "error", message: error instanceof Error ? error.message : "任务加载失败" });
      }
    });
    return () => controller.abort();
  }, [load]);

  if (state.kind === "loading") {
    return <Shell active="我的待办"><Header title="正在打开任务" badge="个人任务" /><Surface>正在确认任务状态…</Surface></Shell>;
  }
  if (state.kind === "error" || state.kind === "blocked") {
    return (
      <Shell active="我的待办">
        <Header title="当前任务无法处理" badge="需要处理" action="返回我的待办" actionHref={todoReturnPath(window.location.search) ?? "/ui/my-tasks"} />
        <Surface><StatusBadge tone="warning">暂不可操作</StatusBadge><p>{state.kind === "error" ? state.message : state.reason}</p></Surface>
      </Shell>
    );
  }
  if (state.kind === "completed") {
    if (state.todo.route.routeName !== "wage_period_detail") {
      const route = state.todo.route;
      const node = workflowNodeForTodo(state.todo);
      const externalCaseId = focusedExternalCaseId(state.todo);
      return <ReworkDetailPage
        reworkOrderId={route.reworkOrderId ?? route.entityId}
        focusedNode={node}
        {...(externalCaseId ? { focusedExternalCaseId: externalCaseId } : {})}
        returnToTodos
      />;
    }
    return (
      <Shell active="我的待办">
        <Header title="任务已完成" badge="已完成" action="返回我的待办" actionHref={todoReturnPath(window.location.search) ?? "/ui/my-tasks"} />
        <Surface className="my-todos-state my-todos-complete">
          <StatusBadge tone="success">已完成</StatusBadge>
          <h2>您在本订单内的任务已全部完成，谢谢。</h2>
          <p>下一步已按业务规则进入对应处理人的个人待办。</p>
        </Surface>
      </Shell>
    );
  }

  const todo = state.todo;
  const route = todo.route;
  const orderId = route.reworkOrderId ?? route.entityId;
  if (route.routeName !== "wage_period_detail") {
    const node = workflowNodeForTodo(todo);
    const externalCaseId = focusedExternalCaseId(todo);
    return <ReworkDetailPage
      reworkOrderId={orderId}
      focusedNode={node}
      {...(externalCaseId ? { focusedExternalCaseId: externalCaseId } : {})}
      returnToTodos
    />;
  }
  return (
    <Shell active="我的待办">
      <Header title="核对本期返工工资" subtitle="返工工资核对任务" badge="当前由你处理" action="返回我的待办" actionHref={todoReturnPath(window.location.search) ?? "/ui/my-tasks"} />
      <Surface className="task-guidance">
        <p><b>你现在要做：</b>核对本期返工工资</p>
        <p><b>完成后：</b>进入下一位工资核对或月结处理人。</p>
      </Surface>
      <WagePeriodDetailPage periodId={route.entityId} />
    </Shell>
  );
}
