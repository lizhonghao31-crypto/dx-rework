import { TodoListResponseSchema, type TodoResponse } from "@dx-rework/contracts";
import { StatusBadge, Surface } from "@dx-rework/ui";
import { useCallback, useEffect, useState } from "react";

import { createWebUrls } from "../url-contract.js";
import { Header, Shell } from "./components.js";
import { ExternalResponsibilityPanel } from "./external-responsibility-panel.js";
import { OwnFactoryApprovalPanel } from "./own-factory-approval-panel.js";
import { ResponsibilityDeterminationPanel } from "./responsibility-determination-panel.js";

const { apiUrl, pageUrl } = createWebUrls(import.meta.env.BASE_URL);
const refreshMilliseconds = 1_500;

type ResponsibilityRouteName =
  | "responsibility_detail"
  | "own_factory_approval"
  | "external_responsibility_detail";

type ResponsibilityTodo = TodoResponse & {
  route: TodoResponse["route"] & { routeName: ResponsibilityRouteName };
};

type State =
  | { kind: "loading" }
  | { kind: "ready"; todo: ResponsibilityTodo }
  | { kind: "completed"; nextTodoId: string | null }
  | { kind: "blocked"; reason: string }
  | { kind: "error"; message: string };

const meta: Record<ResponsibilityRouteName, { title: string; after: string }> = {
  responsibility_detail: {
    title: "确认本单责任分配",
    after: "系统会按责任结果，把本厂承担或各供应商扣款分别交给对应处理人。",
  },
  own_factory_approval: {
    title: "审批本厂承担金额",
    after: "审批完成后，本厂部分结束；外部责任继续由对应供应商经办和应付处理。",
  },
  external_responsibility_detail: {
    title: "处理这一家供应商的扣款",
    after: "本任务完成后，下一步会进入对应处理人的个人待办。",
  },
};

const todoIdFromLocation = (): string | null => {
  const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
  const path = window.location.pathname.startsWith(basePath)
    ? window.location.pathname.slice(basePath.length) || "/"
    : window.location.pathname;
  return path.match(/^\/ui\/my-tasks\/([0-9a-f-]{36})$/i)?.[1] ?? null;
};

const isResponsibilityTodo = (todo: TodoResponse): todo is ResponsibilityTodo => [
  "responsibility_detail",
  "own_factory_approval",
  "external_responsibility_detail",
].includes(todo.route.routeName);

export function ResponsibilityTaskPage() {
  const todoId = todoIdFromLocation();
  const [state, setState] = useState<State>({ kind: "loading" });

  const load = useCallback(async (signal?: AbortSignal): Promise<void> => {
    if (!todoId) {
      setState({ kind: "error", message: "任务链接无效" });
      return;
    }
    const response = await fetch(apiUrl("todos/mine"), {
      credentials: "include",
      headers: { accept: "application/json" },
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) throw new Error(`任务加载失败（${response.status}）`);
    const { todos } = TodoListResponseSchema.parse(await response.json());
    const todo = todos.find((item) => item.todoId === todoId);
    if (!todo || todo.status === "completed" || todo.status === "cancelled") {
      const next = todos.find((item) =>
        item.todoId !== todoId
        && item.todoType !== "information"
        && item.status === "pending"
        && isResponsibilityTodo(item));
      setState({ kind: "completed", nextTodoId: next?.todoId ?? null });
      return;
    }
    if (todo.status === "blocked_recipient") {
      setState({ kind: "blocked", reason: todo.blockedReason ?? "当前任务需要由管理人员转交。" });
      return;
    }
    if (!isResponsibilityTodo(todo)) {
      setState({ kind: "error", message: "该任务不属于责任处理链，请返回我的待办。" });
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
    const interval = window.setInterval(() => void load().catch(() => undefined), refreshMilliseconds);
    const refresh = () => void load().catch(() => undefined);
    window.addEventListener("focus", refresh);
    return () => {
      controller.abort();
      window.clearInterval(interval);
      window.removeEventListener("focus", refresh);
    };
  }, [load]);

  useEffect(() => {
    if (state.kind === "completed" && state.nextTodoId) {
      window.location.replace(pageUrl(`ui/my-tasks/${state.nextTodoId}`));
    }
  }, [state]);

  if (state.kind === "loading") {
    return <Shell active="我的待办"><Header title="正在打开任务" badge="个人任务" /><Surface>正在确认任务状态…</Surface></Shell>;
  }
  if (state.kind === "error" || state.kind === "blocked") {
    return (
      <Shell active="我的待办">
        <Header title="当前任务无法处理" badge="需要处理" action="返回我的待办" actionHref="/ui/my-tasks" />
        <Surface><StatusBadge tone="warning">暂不可操作</StatusBadge><p>{state.kind === "error" ? state.message : state.reason}</p></Surface>
      </Shell>
    );
  }
  if (state.kind === "completed") {
    return (
      <Shell active="我的待办">
        <Header title="任务已完成" badge="已完成" action="返回我的待办" actionHref="/ui/my-tasks" />
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
  const pageMeta = meta[route.routeName];
  return (
    <Shell active="我的待办">
      <Header title={pageMeta.title} subtitle={todo.category} badge="当前由你处理" action="返回我的待办" actionHref="/ui/my-tasks" />
      <Surface className="task-guidance">
        <p><b>你现在要做：</b>{pageMeta.title}</p>
        <p><b>完成后：</b>{pageMeta.after}</p>
      </Surface>
      {route.routeName === "responsibility_detail" && <ResponsibilityDeterminationPanel reworkOrderId={orderId} />}
      {route.routeName === "own_factory_approval" && <OwnFactoryApprovalPanel reworkOrderId={orderId} />}
      {route.routeName === "external_responsibility_detail" && (
        <ExternalResponsibilityPanel reworkOrderId={orderId} focusCaseId={route.entityId} />
      )}
    </Shell>
  );
}
