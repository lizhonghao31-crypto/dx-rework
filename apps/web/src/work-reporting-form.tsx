import { moduleCanWrite } from "./member-module-policy.js";
import {
  ProcessConfigurationResponseSchema,
  ReworkWorkTasksResponseSchema,
  WorkTaskAssignablePeopleResponseSchema,
  WorkTaskResponseSchema,
  WorkReportResponseSchema,
  WorkReportsBatchResponseSchema,
  type ReworkWorkTasksResponse,
} from "@dx-rework/contracts";
import { formatBusinessCurrency, formatBusinessDecimal } from "@dx-rework/contracts/business-display";
import { Button, InsetField, StatusBadge, Surface } from "@dx-rework/ui";
import { useEffect, useMemo, useState, type ReactElement } from "react";

import { createWebUrls } from "../url-contract.js";
import { createClientRequestId } from "./client-request-id.js";
import { verifySession } from "./auth.js";
import { mapWithConcurrency } from "./concurrency.js";
import { canAdjustActiveWorkforce, canAssignWork, type WorkReportingUser } from "./work-reporting-permissions.js";
import { reportsArePersisted } from "./work-reporting-submission.js";
import { alertInApp } from "./system-dialog.js";
import { IePrecountCell, type IePrecountOverview } from "./ie-precount-cell.js";
import { WholeOrderReviewPanel } from "./whole-order-review-panel.js";
import "./work-reporting-form.css";

const { apiUrl } = createWebUrls(import.meta.env.BASE_URL);
type Person = {
  personId: string;
  displayName: string;
  personType: "internal" | "temporary";
  eligibleExecutionKinds: Array<"worker" | "tail_inspection">;
};
type Task = ReworkWorkTasksResponse["tasks"][number];
type ProgressProcessGroup = Readonly<{
  configurationItemId: string;
  processName: string;
  tasks: readonly Task[];
}>;
export type FrontlineWorkContext = Readonly<{
  kind: "worker" | "tail_inspection";
  reworkNo: string | null;
  styleNo: string | null;
  processNames: readonly string[];
}>;

const request = async <T,>(path: string, parse: (value: unknown) => T, init?: RequestInit): Promise<T> => {
  const response = await fetch(apiUrl(path), {
    credentials: "include", ...init,
    headers: { accept: "application/json", ...(init?.body ? { "content-type": "application/json" } : {}), ...init?.headers },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
    throw new Error(body?.error?.message ?? "请求未完成，请稍后重试");
  }
  return parse(await response.json());
};

const requestNoContent = async (path: string, init?: RequestInit): Promise<void> => {
  const response = await fetch(apiUrl(path), {
    credentials: "include", ...init,
    headers: { accept: "application/json", ...(init?.body ? { "content-type": "application/json" } : {}), ...init?.headers },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
    throw new Error(body?.error?.message ?? "请求未完成，请稍后重试");
  }
};

const canReviewOrder = (user: WorkReportingUser): boolean => user.isRoot === true || [
  "submission:audit", "quantity:adjust", "quantity:confirm", "process:review",
].some((capability) => user.capabilities.includes(capability));
const canReadWorkFacts = (user: WorkReportingUser): boolean =>
  canAssignWork(user)
  || (user.businessRoles?.includes("worker") === true && user.capabilities.includes("work:report"))
  || (user.businessRoles?.includes("tail_inspector") === true && user.capabilities.includes("tail_inspection:report"))
  || user.capabilities.includes("work:report_for_worker")
  || (user.businessRoles?.includes("owner_group") === true && user.capabilities.includes("business:read_all"));

const taskProcessName = (task: Task): string =>
  task.executionKind === "tail_inspection" ? "整查" : task.processName;

const groupTasksByProcess = (tasks: readonly Task[]): Task[] => {
  const processOrder = new Map<string, number>();
  tasks.forEach((task) => {
    const processName = taskProcessName(task);
    if (!processOrder.has(processName)) processOrder.set(processName, processOrder.size);
  });
  return tasks
    .map((task, index) => ({ task, index }))
    .sort((left, right) =>
      (processOrder.get(taskProcessName(left.task)) ?? 0) - (processOrder.get(taskProcessName(right.task)) ?? 0)
      || left.index - right.index)
    .map(({ task }) => task);
};

const buildProgressProcessGroups = (tasks: readonly Task[]): ProgressProcessGroup[] => {
  const groups: Array<{ configurationItemId: string; processName: string; tasks: Task[] }> = [];
  const byConfiguration = new Map<string, { configurationItemId: string; processName: string; tasks: Task[] }>();
  for (const task of groupTasksByProcess(tasks)) {
    const existing = byConfiguration.get(task.configurationItemId);
    if (existing) {
      existing.tasks.push(task);
      continue;
    }
    const group = {
      configurationItemId: task.configurationItemId,
      processName: taskProcessName(task),
      tasks: [task],
    };
    byConfiguration.set(task.configurationItemId, group);
    groups.push(group);
  }
  return groups;
};

function ReturnedReportContext({ task }: Readonly<{ task: Task }>): ReactElement | null {
  if (!task.returnedReport) return null;
  return <div className="work-reporting-return-context" role="status">
    <StatusBadge tone="warning">报数已退回</StatusBadge>
    <p>退回原因：{task.returnedReport.reason}</p>
    <p>原上报数量：{formatBusinessDecimal(task.returnedReport.originalQuantity)} 件，请核对后重新上报。</p>
  </div>;
}

function ManagerWorkerProgressRow({
  task,
  writable,
  onRemove,
}: Readonly<{
  task: Task;
  writable: boolean;
  onRemove?: () => void;
}>): ReactElement {
  const completed = task.remainingQuantity === 0;
  const temporary = task.members.some((member) => member.personType === "temporary");
  return <div className="n04-worker-row">
    <div className="n04-progress-fact n04-progress-fact--worker">
      <small>{task.executionKind === "tail_inspection" ? "整查人员" : "返工人员"}</small>
      <span>{onRemove ? <button type="button" className="n04-worker-remove" aria-label={`移除${task.members[0]?.displayName ?? "该员工"}`} onClick={onRemove}><span aria-hidden="true">−</span></button> : null}<b>{task.members.map((member) => member.displayName).join("、")}</b>{temporary ? <em>临时工</em> : null}</span>
    </div>
    <div className="n04-progress-fact"><small>状态</small><StatusBadge tone={completed ? "success" : writable ? "warning" : "info"}>{completed ? "已完成" : writable ? "待上报" : "未完成"}</StatusBadge></div>
    <div className="n04-progress-fact n04-progress-fact--quantity"><small>上报数量</small><b className={completed ? "is-completed" : ""}>{completed ? `${formatBusinessDecimal(task.submittedQuantity)}件` : "—"}</b></div>
    <ReturnedReportContext task={task} />
  </div>;
}

function ManagerProcessProgressGroup({
  group,
  reworkOrderId,
  writable,
  expanded,
  iePrecounts,
  removableTaskIds,
  onToggle,
  onIePrecountChanged,
  onRemoveTask,
}: Readonly<{
  group: ProgressProcessGroup;
  reworkOrderId: string;
  writable: boolean;
  expanded: boolean;
  iePrecounts?: IePrecountOverview;
  history?: ReworkWorkTasksResponse;
  removableTaskIds: ReadonlySet<string>;
  onToggle: () => void;
  onIePrecountChanged?: () => Promise<void> | void;
  onRemoveTask: (task: Task) => void;
}>): ReactElement {
  const completedCount = group.tasks.filter((task) => task.remainingQuantity === 0).length;
  const incompleteCount = group.tasks.length - completedCount;
  const workerCount = group.tasks.reduce((total, task) => total + task.members.length, 0);
  const submittedTotal = group.tasks.reduce((total, task) => total + task.submittedQuantity, 0);
  const allCompleted = incompleteCount === 0;
  const detailId = `n04-process-${group.configurationItemId}`;

  return <Surface className={`n04-process-group${allCompleted ? " is-completed" : ""}`}>
    <div className="n04-process-group__header">
      <button type="button" className="n04-process-group__main" aria-expanded={expanded} aria-controls={detailId} onClick={onToggle}>
        <strong>{group.processName}</strong>
        <span><small>人员</small><b>{formatBusinessDecimal(workerCount)}人</b></span>
        <span><small>完成</small><b>{formatBusinessDecimal(completedCount)}/{formatBusinessDecimal(group.tasks.length)}</b></span>
        <span><small>上报合计</small><b>{formatBusinessDecimal(submittedTotal)}件</b></span>
        <StatusBadge tone={allCompleted ? "success" : "warning"}>{allCompleted ? "已完成" : `未完成 ${formatBusinessDecimal(incompleteCount)}`}</StatusBadge>
      </button>
      {iePrecounts && group.tasks.some(task => task.executionKind === "worker") ? <IePrecountCell
        reworkOrderId={reworkOrderId}
        configurationItemId={group.configurationItemId}
        processName={group.processName}
        overview={iePrecounts}
        {...(onIePrecountChanged ? { onChanged: onIePrecountChanged } : {})}
      /> : null}
      <button type="button" className="n04-process-group__expander" aria-expanded={expanded} aria-controls={detailId} onClick={onToggle}>{expanded ? "收起 −" : "展开 +"}</button>
    </div>
    {expanded ? <div className="n04-process-workers" id={detailId}>
      {group.tasks.map((task) => <ManagerWorkerProgressRow
        key={task.workTaskId}
        task={task}
        writable={writable}
        {...(removableTaskIds.has(task.workTaskId) ? { onRemove: () => onRemoveTask(task) } : {})}
      />)}
    </div> : null}
  </Surface>;
}

export function WorkReportingForm({
  reworkOrderId: providedReworkOrderId,
  taskMode = "workspace",
  onOrderChanged,
  embedded = false,
  frontlineContext,
  onFrontlineExit,
  iePrecounts,
  history,
}: {
  reworkOrderId?: string;
  taskMode?: "workspace" | "task_assignment" | "work_reporting" | "whole_order_review";
  onOrderChanged?: () => Promise<void> | void;
  embedded?: boolean;
  frontlineContext?: FrontlineWorkContext;
  onFrontlineExit?: () => void;
  iePrecounts?: IePrecountOverview;
  history?: ReworkWorkTasksResponse;
} = {}) {
  const reworkOrderId = providedReworkOrderId ?? new URLSearchParams(window.location.search).get("rework");
  const [data, setData] = useState<ReworkWorkTasksResponse | null>(history ?? null);
  const [configItems, setConfigItems] = useState<Array<{ configurationItemId: string; processName: string; executionKind: "worker" | "tail_inspection" }>>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [peopleType, setPeopleType] = useState<"internal" | "temporary">("internal");
  const [peopleQuery, setPeopleQuery] = useState("");
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [removalTask, setRemovalTask] = useState<Task | null>(null);
  const [adjustmentDialogOpen, setAdjustmentDialogOpen] = useState(false);
  const [adjustmentConfigurationItemId, setAdjustmentConfigurationItemId] = useState("");
  const [temporaryDialogOpen, setTemporaryDialogOpen] = useState(false);
  const [temporaryName, setTemporaryName] = useState("");
  const [temporaryRemark, setTemporaryRemark] = useState("");
  const [temporaryPhoneNumber, setTemporaryPhoneNumber] = useState("");
  const [temporaryIdentityNumber, setTemporaryIdentityNumber] = useState("");
  const [reportTasks, setReportTasks] = useState<Task[] | null>(null);
  const [reportQuantities, setReportQuantities] = useState<Record<string, string>>({});
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [canAssign, setCanAssign] = useState(false);
  const [canAdjustActive, setCanAdjustActive] = useState(false);
  const [canCreateTemporary, setCanCreateTemporary] = useState(false);
  const [isRoot, setIsRoot] = useState(false);
  const [moduleWritable, setModuleWritable] = useState(false);
  const [reviewEligible, setReviewEligible] = useState(false);
  const [expandedProcesses, setExpandedProcesses] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!removalTask && !adjustmentDialogOpen && !temporaryDialogOpen && !reportTasks) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (busy) return;
      if (temporaryDialogOpen) setTemporaryDialogOpen(false);
      else if (reportTasks) setReportTasks(null);
      else if (removalTask) setRemovalTask(null);
      else setAdjustmentDialogOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [removalTask, adjustmentDialogOpen, temporaryDialogOpen, reportTasks, busy]);

  const filteredPeople = useMemo(() => {
    const selectedConfiguration = configItems.find((item) => item.configurationItemId === adjustmentConfigurationItemId);
    const alreadyAssigned = new Set(
      data?.tasks
        .filter((task) => task.configurationItemId === adjustmentConfigurationItemId && task.status === "active")
        .flatMap((task) => task.members.map((member) => member.personId)) ?? [],
    );
    const typedPeople = people.filter((person) =>
      person.personType === peopleType
      && (!adjustmentDialogOpen || (
        selectedConfiguration !== undefined
        && person.eligibleExecutionKinds.includes(selectedConfiguration.executionKind)
        && !alreadyAssigned.has(person.personId)
      )));
    const needle = peopleQuery.trim().toLocaleLowerCase("zh-CN");
    if (!needle) return typedPeople;
    return typedPeople.filter((person) => person.displayName.toLocaleLowerCase("zh-CN").includes(needle));
  }, [adjustmentConfigurationItemId, adjustmentDialogOpen, configItems, data?.tasks, people, peopleQuery, peopleType]);

  const reload = async (): Promise<ReworkWorkTasksResponse | null> => {
    if (history) return history;
    if (!reworkOrderId) return null;
    const loaded = await request(`rework-orders/${reworkOrderId}/work-tasks`, ReworkWorkTasksResponseSchema.parse);
    setData(loaded);
    return loaded;
  };

  const reloadPeople = async (): Promise<Person[]> => {
    const peopleResult = await request("work-task-options", WorkTaskAssignablePeopleResponseSchema.parse);
    setPeople(peopleResult.people);
    return peopleResult.people;
  };

  useEffect(() => {
    if (history) return;
    if (!reworkOrderId) { setMessage("请从当前节点工作台选择一张订单进入处理。"); return; }
    const load = async () => {
      const session = await verifySession();
      if (session === "denied" || session.status !== "authorized") throw new Error("当前登录状态已失效，请重新登录。");
      const writable = moduleCanWrite(session.user, "rework");
      setModuleWritable(writable);
      const assignable = writable && canAssignWork(session.user);
      const activeAdjustable = writable && canAdjustActiveWorkforce(session.user);
      const root = session.user.isRoot === true;
      const taskReadable = canReadWorkFacts(session.user) || iePrecounts !== undefined;
      const orderReviewable = canReviewOrder(session.user);
      const temporaryManageable = writable && (root || session.user.capabilities.includes("temporary_worker:manage"));
      setCanAssign(assignable); setCanAdjustActive(activeAdjustable); setCanCreateTemporary(temporaryManageable); setIsRoot(root); setReviewEligible(orderReviewable);
      const loaded = taskReadable ? await reload() : null;
      if (!taskReadable) setMessage(orderReviewable ? "当前岗位只处理尾部确认，不展示工人的个人上数。" : "当前岗位没有这个节点的处理权限。");
      const assignmentView = loaded?.reworkStatus === "pending_task_assignment"
        && (taskMode === "task_assignment" || taskMode === "workspace");
      const adjustmentView = loaded?.reworkStatus === "in_progress"
        && (taskMode === "work_reporting" || taskMode === "workspace");
      if ((!assignable || !assignmentView) && (!activeAdjustable || !adjustmentView)) return;
      const [, configuration] = await Promise.all([
        request(
          adjustmentView ? "work-task-adjustment-options" : "work-task-options",
          WorkTaskAssignablePeopleResponseSchema.parse,
        ).then((result) => setPeople(result.people)),
        request(`rework-orders/${reworkOrderId}/process-configuration`, ProcessConfigurationResponseSchema.parse),
      ]);
      setConfigItems(configuration.configuration?.items.map((item) => ({
        configurationItemId: item.configurationItemId,
        processName: item.executionKind === "tail_inspection" ? "整查" : item.processName,
        executionKind: item.executionKind,
      })) ?? []);
    };
    void load().catch((cause: unknown) => setMessage(cause instanceof Error ? cause.message : "当前节点加载失败"));
  }, [reworkOrderId, taskMode]);

  const choosePeopleType = (type: "internal" | "temporary") => {
    setPeopleType(type);
    setPeopleQuery("");
    setSelected({});
  };

  const assign = async (configurationItemId: string) => {
    if (!data || data.reworkStatus !== "pending_task_assignment" || busy) return;
    const memberIds = people.filter((person) => selected[person.personId]).map((person) => person.personId);
    if (memberIds.length === 0) {
      const issue = "请至少选择一名返工人员。";
      setMessage(issue);
      await alertInApp(issue, { title: "人员分配暂不能提交", confirmLabel: "知道了" });
      return;
    }
    setBusy(true);
    try {
      const assigned = await mapWithConcurrency(memberIds, 3, (personId) => request(`rework-orders/${data.reworkOrderId}/work-tasks`, WorkTaskResponseSchema.parse, {
        method: "POST", headers: { "idempotency-key": createClientRequestId() },
        body: JSON.stringify({ expectedOrderVersion: data.orderVersion, configurationItemId, mode: "individual", members: [{ personId }] }),
      }));
      setData({ ...data, tasks: [...data.tasks, ...assigned] });
      setSelected({}); setMessage("人员已分配。各工序都分完后，再统一点击“开始返工”。");
    } catch (cause) {
      await reload().catch(() => null);
      setMessage(cause instanceof Error ? cause.message : "人员分配失败");
    } finally { setBusy(false); }
  };

  const openActiveAddition = () => {
    const firstConfiguration = configItems[0]?.configurationItemId ?? "";
    setAdjustmentConfigurationItemId(firstConfiguration);
    setPeopleType("internal");
    setPeopleQuery("");
    setSelected({});
    setAdjustmentDialogOpen(true);
  };

  const addActiveMembers = async () => {
    if (!data || data.reworkStatus !== "in_progress" || !canAdjustActive || busy) return;
    if (!adjustmentConfigurationItemId) {
      const issue = "请选择要增加员工的工序。";
      setMessage(issue);
      await alertInApp(issue, { title: "新增员工暂不能提交", confirmLabel: "知道了" });
      return;
    }
    const memberIds = filteredPeople.filter((person) => selected[person.personId]).map((person) => person.personId);
    if (memberIds.length === 0) {
      const issue = "请至少选择一名新增员工。";
      setMessage(issue);
      await alertInApp(issue, { title: "新增员工暂不能提交", confirmLabel: "知道了" });
      return;
    }
    setBusy(true);
    try {
      const adjusted = await request(
        `rework-orders/${data.reworkOrderId}/work-tasks/add-members`,
        ReworkWorkTasksResponseSchema.parse,
        {
          method: "POST",
          headers: { "idempotency-key": createClientRequestId() },
          body: JSON.stringify({
            expectedOrderVersion: data.orderVersion,
            configurationItemId: adjustmentConfigurationItemId,
            memberIds,
          }),
        },
      );
      setData(adjusted);
      setAdjustmentDialogOpen(false);
      setSelected({});
      setMessage(`已新增 ${memberIds.length} 名员工，仅应用于当前订单。`);
    } catch (cause) {
      await reload().catch(() => null);
      setMessage(cause instanceof Error ? cause.message : "新增员工失败");
    } finally {
      setBusy(false);
    }
  };

  const confirmRemoval = async () => {
    if (!data || !removalTask || busy) return;
    const workerName = removalTask.members[0]?.displayName ?? "该人员";
    setBusy(true);
    try {
      if (data.reworkStatus === "in_progress") {
        const adjusted = await request(
          `rework-orders/${data.reworkOrderId}/work-tasks/${removalTask.workTaskId}/remove-active`,
          ReworkWorkTasksResponseSchema.parse,
          {
            method: "POST",
            headers: { "idempotency-key": createClientRequestId() },
            body: JSON.stringify({ expectedOrderVersion: data.orderVersion }),
          },
        );
        setData(adjusted);
      } else if (data.reworkStatus === "pending_task_assignment") {
        await requestNoContent(`work-tasks/${removalTask.workTaskId}/remove`, {
          method: "POST",
          headers: { "idempotency-key": createClientRequestId() },
          body: JSON.stringify({ expectedOrderVersion: data.orderVersion }),
        });
        await reload();
      } else {
        throw new Error("当前节点不能移除员工。");
      }
      setRemovalTask(null);
      setMessage(`已从当前订单移除 ${workerName}。`);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "无法移除该人员分配");
    } finally {
      setBusy(false);
    }
  };

  const createTemporaryWorker = async () => {
    if (!canCreateTemporary || busy) return;
    const displayName = temporaryName.trim();
    const remark = temporaryRemark.trim();
    const phoneNumber = temporaryPhoneNumber.trim().replace(/[\s-]/g, "");
    const identityNumber = temporaryIdentityNumber.trim().toUpperCase();
    if (!displayName) {
      const issue = "请填写临时工姓名。";
      setMessage(issue);
      await alertInApp(issue, { title: "临时工暂不能添加", confirmLabel: "知道了" });
      return;
    }
    setBusy(true);
    try {
      await request("master-data/temporary-workers", (value) => value as { personId: string }, {
        method: "POST",
        body: JSON.stringify({
          personType: "temporary",
          displayName,
          aliases: [],
          reason: "N04 现场新增临时工",
          ...(remark ? { temporaryRemark: remark } : {}),
          ...(phoneNumber ? { temporaryPhoneNumber: phoneNumber } : {}),
          ...(identityNumber ? { temporaryIdentityNumber: identityNumber } : {}),
        }),
      });
      await reloadPeople();
      setPeopleType("temporary");
      setPeopleQuery("");
      setSelected({});
      setTemporaryName("");
      setTemporaryRemark("");
      setTemporaryPhoneNumber("");
      setTemporaryIdentityNumber("");
      setTemporaryDialogOpen(false);
      setMessage(`临时工 ${displayName} 已添加，可直接选择分配。`);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "临时工添加失败");
    } finally {
      setBusy(false);
    }
  };

  const confirmAssignments = async () => {
    if (!data || data.reworkStatus !== "pending_task_assignment" || busy) return;
    const allAssigned = configItems.length > 0 && configItems.every((item) =>
      data.tasks.some((task) => task.configurationItemId === item.configurationItemId));
    if (!allAssigned) {
      const issue = "请先为每道工序分配至少一名返工人员。";
      setMessage(issue);
      await alertInApp(issue, { title: "返工暂不能开始", confirmLabel: "知道了" });
      return;
    }
    setBusy(true);
    try {
      const confirmed = await request(`rework-orders/${data.reworkOrderId}/work-tasks/confirm`, ReworkWorkTasksResponseSchema.parse, {
        method: "POST", headers: { "idempotency-key": createClientRequestId() }, body: JSON.stringify({ expectedOrderVersion: data.orderVersion }),
      });
      setData(confirmed); setMessage("返工已开始。工人只需在真正完工后点击“我已完工&上数”。"); await onOrderChanged?.();
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : "无法开始返工"); } finally { setBusy(false); }
  };

  const openReporting = (tasks: Task[]) => {
    setReportTasks(tasks);
    setReportQuantities(Object.fromEntries(tasks.map((task) => [task.workTaskId, ""])));
  };
  const submitReports = async () => {
    if (!data || data.reworkStatus !== "in_progress" || !reportTasks || busy) return;
    const quantities = reportTasks.map((task) => ({ task, text: reportQuantities[task.workTaskId]?.trim() ?? "" }));
    if (quantities.some(({ text }) => !/^\d+$/.test(text) || Number(text) <= 0)) {
      const issue = "请把每项实际完工件数填写为大于 0 的整数件数。";
      setMessage(issue);
      await alertInApp(issue, { title: "返工报数暂不能提交", confirmLabel: "知道了" });
      return;
    }
    setBusy(true);
    setMessage(quantities.length > 1
      ? `正在批量提交 ${formatBusinessDecimal(quantities.length)} 项报数，请勿关闭页面或重复操作。`
      : "正在提交报数，请勿重复操作。");
    try {
      let submittedStatus: ReworkWorkTasksResponse["reworkStatus"] | undefined;
      if (quantities.length === 1) {
        const quantity = quantities[0]!;
        await request(`work-tasks/${quantity.task.workTaskId}/reports`, WorkReportResponseSchema.parse, {
          method: "POST",
          headers: { "idempotency-key": createClientRequestId() },
          body: JSON.stringify({ expectedOrderVersion: data.orderVersion, actualQuantity: Number(quantity.text) }),
        });
      } else {
        const submitted = await request(
          `rework-orders/${data.reworkOrderId}/work-reports/batch`,
          WorkReportsBatchResponseSchema.parse,
          {
            method: "POST",
            headers: { "idempotency-key": createClientRequestId() },
            body: JSON.stringify({
              expectedOrderVersion: data.orderVersion,
              reports: quantities.map(({ task, text }) => ({
                workTaskId: task.workTaskId,
                actualQuantity: Number(text),
              })),
            }),
          },
        );
        submittedStatus = submitted.reworkStatus;
      }
      setReportTasks(null);
      const loaded = await reload().catch(() => null);
      if ((loaded?.reworkStatus ?? submittedStatus) === "pending_order_review") {
        setMessage(`${formatBusinessDecimal(quantities.length)} 项返工执行报数已全部完成，已流转至 N05 · 尾部最终数量确认。`);
        try { await onOrderChanged?.(); } catch { /* The committed batch remains successful even if the surrounding page refresh fails. */ }
      } else {
        setMessage(`${formatBusinessDecimal(quantities.length)} 项报数已确认；系统继续等待其他返工人员或整查完成。`);
      }
    } catch (cause) {
      const loaded = quantities.length > 1 ? await reload().catch(() => null) : null;
      if (loaded && reportsArePersisted(
        loaded.tasks,
        quantities.map(({ task, text }) => ({ workTaskId: task.workTaskId, actualQuantity: Number(text) })),
      )) {
        setReportTasks(null);
        if (loaded.reworkStatus === "pending_order_review") {
          setMessage(`${formatBusinessDecimal(quantities.length)} 项返工执行报数已保存，已流转至 N05 · 尾部最终数量确认。`);
          try { await onOrderChanged?.(); } catch { /* The committed batch remains successful even if the surrounding page refresh fails. */ }
        } else {
          setMessage(`${formatBusinessDecimal(quantities.length)} 项报数已保存；系统继续等待其他返工人员或整查完成。`);
        }
        return;
      }
      const failure = cause instanceof Error ? cause.message : "完工上数失败";
      setMessage(failure);
      await alertInApp(failure, { title: "返工报数提交失败", confirmLabel: "知道了" });
    } finally {
      setBusy(false);
    }
  };


  const completeExecution = async () => {
    if (!data || data.reworkStatus !== "in_progress" || busy) return;
    setBusy(true);
    setMessage("正在核验返工与整查报数…");
    try {
      const completed = await request(
        `rework-orders/${data.reworkOrderId}/work-tasks/complete`,
        ReworkWorkTasksResponseSchema.parse,
        {
          method: "POST",
          headers: { "idempotency-key": createClientRequestId() },
          body: JSON.stringify({ expectedOrderVersion: data.orderVersion }),
        },
      );
      setData(completed);
      setMessage("全部任务已核验，已流转至 N05 · 尾部最终数量确认。");
      try { await onOrderChanged?.(); } catch { /* The committed transition remains successful if the outer refresh fails. */ }
    } catch (cause) {
      const failure = cause instanceof Error ? cause.message : "无法进入最终数量确认";
      setMessage(failure);
      await alertInApp(failure, { title: "流程提交失败", confirmLabel: "知道了" });
      await reload().catch(() => null);
    } finally {
      setBusy(false);
    }
  };

  const effectiveTaskMode = taskMode === "workspace"
    ? data?.reworkStatus === "pending_task_assignment" ? "task_assignment" : ["pending_order_review", "pending_final_quantity_ie_review"].includes(data?.reworkStatus ?? "") ? "whole_order_review" : "work_reporting"
    : taskMode;
  const assignmentWritable = moduleWritable && data?.reworkStatus === "pending_task_assignment";
  const workReportingWritable = moduleWritable && data?.reworkStatus === "in_progress";
  const loadedReworkOrderId = data?.reworkOrderId ?? "";
  const visibleTasks = groupTasksByProcess(data?.tasks.filter((task) => !frontlineContext || task.executionKind === frontlineContext.kind) ?? []);
  const incompleteTasks = visibleTasks.filter((task) => task.remainingQuantity !== 0);
  const completedTasks = visibleTasks.filter((task) => task.remainingQuantity === 0);
  const progressProcessGroups = buildProgressProcessGroups(visibleTasks);
  const managerProgressView = !frontlineContext && (Boolean(history) || canAssign || canAdjustActive || iePrecounts !== undefined);
  const activeAdjustmentWritable = data?.reworkStatus === "in_progress" && canAdjustActive;
  const pendingTasks = visibleTasks.filter((task) => workReportingWritable && task.canSubmitReport);
  const temporaryTasks = pendingTasks.filter((task) => task.members.some((member) => member.personType === "temporary"));
  const reportableTasks = isRoot ? pendingTasks : canAssign ? temporaryTasks : pendingTasks;
  const selfReportableTaskIds = new Set(
    !isRoot && !canAssign ? reportableTasks.map((task) => task.workTaskId) : [],
  );
  const allProcessesAssigned = configItems.length > 0 && configItems.every((item) => data?.tasks.some((task) => task.configurationItemId === item.configurationItemId));
  const selectedPeopleCount = people.filter((person) => selected[person.personId]).length;
  const adjustmentSelectedCount = filteredPeople.filter((person) => selected[person.personId]).length;
  const removableActiveTaskIds = new Set(
    incompleteTasks
      .filter((task) =>
        activeAdjustmentWritable
        && task.mode === "individual"
        && task.members.length === 1)
      .map((task) => task.workTaskId),
  );
  const reportsReady = Boolean(reportTasks?.length && reportTasks.every((task) => {
    const text = reportQuantities[task.workTaskId]?.trim() ?? "";
    return /^\d+$/.test(text) && Number(text) > 0;
  }));

  if (effectiveTaskMode === "whole_order_review") return <div className="mobile-page work-reporting-page">
    {!reviewEligible && <Surface>{message}</Surface>}
    {reworkOrderId && reviewEligible && <WholeOrderReviewPanel reworkOrderId={reworkOrderId} embedded={embedded} onChanged={async () => { await onOrderChanged?.(); }} {...(iePrecounts ? { iePrecounts } : {})} />}
  </div>;

  return <div className={`mobile-page work-reporting-page${embedded ? " is-embedded" : ""}${frontlineContext ? " is-frontline" : ""}`}>
    {!embedded && !frontlineContext && <div className="mobile-hero"><div className="mobile-title"><h1>{effectiveTaskMode === "task_assignment" ? "历史人员分配" : "返工执行报数"}</h1><StatusBadge tone="info">{effectiveTaskMode === "task_assignment" ? "历史流程" : "N04"}</StatusBadge></div><p>{effectiveTaskMode === "task_assignment" ? "仅用于兼容旧订单；新订单已在节点02完成返工人员预分配。" : "返工人员与整查都在本节点按本人任务填写实际整数件数。"}</p></div>}
    {frontlineContext ? <header className="frontline-work-context">
      <button type="button" onClick={() => onFrontlineExit?.()}>← 返回任务</button>
      <div><strong>{frontlineContext.styleNo ?? "款号未填写"}</strong><small>{frontlineContext.reworkNo ?? "返工单号待生成"}</small><span>{frontlineContext.processNames.join("、")}</span></div>
      <StatusBadge tone="warning">{frontlineContext.kind === "tail_inspection" ? "待整查报数" : "待完工上数"}</StatusBadge>
    </header> : null}
    {message && <p className="work-reporting-feedback" role="status">{message}</p>}
    {effectiveTaskMode === "task_assignment" && data && <>
      {data.tasks.length > 0 && <Surface><h2>已分配人员</h2>{data.tasks.map((task) => <div className="section-title whole-order-row n04-assignment-row" key={task.workTaskId}><div><b>{task.processName}</b><p>{task.members.map((member) => member.displayName).join("、")}</p></div><div className="n04-assignment-controls"><StatusBadge tone={assignmentWritable ? "info" : "success"}>{assignmentWritable ? "待开工" : "已处理"}</StatusBadge>{canAssign && assignmentWritable && task.mode === "individual" && task.members.length === 1 && <Button onClick={() => setRemovalTask(task)} disabled={busy}>移除</Button>}</div></div>)}</Surface>}
      {canAssign && assignmentWritable && <Surface><h2>选择人员并分配工序</h2><p>可同时选择多人；临时工由尾部主管代上数。</p>
        <div className="workforce-type-toolbar">
          <div className="workforce-type-tabs" role="tablist" aria-label="返工人员类别">
            <button type="button" role="tab" aria-selected={peopleType === "internal"} className={peopleType === "internal" ? "is-active" : ""} onClick={() => choosePeopleType("internal")} disabled={busy}>正式工</button>
            <button type="button" role="tab" aria-selected={peopleType === "temporary"} className={peopleType === "temporary" ? "is-active" : ""} onClick={() => choosePeopleType("temporary")} disabled={busy}>临时工</button>
          </div>
          {peopleType === "temporary" && canCreateTemporary && <Button onClick={() => setTemporaryDialogOpen(true)} disabled={busy}>+ 添加临时工</Button>}
        </div>
        <InsetField label={`搜索${peopleType === "internal" ? "正式工" : "临时工"}`} type="search" value={peopleQuery} placeholder="输入姓名搜索" disabled={busy} onChange={(event) => setPeopleQuery(event.target.value)} />
        <div className="workforce-person-list">{filteredPeople.map((person) => <label className="process-source" key={person.personId}><input type="checkbox" checked={Boolean(selected[person.personId])} disabled={busy} onChange={(event) => setSelected((current) => ({ ...current, [person.personId]: event.target.checked }))} />{person.displayName}</label>)}</div>
        {filteredPeople.length === 0 && <p>当前没有可选择的{peopleType === "internal" ? "正式工" : "临时工"}。</p>}
        {selectedPeopleCount === 0 && filteredPeople.length > 0 && <p>先选择至少一名返工人员，再分配到对应工序。</p>}
        <div className="mobile-actions work-reporting-actions">{configItems.map((item) => <Button key={item.configurationItemId} onClick={() => void assign(item.configurationItemId)} data-ready={selectedPeopleCount > 0 ? "true" : "false"} disabled={busy}>分配 {item.processName}</Button>)}</div>
        <Button variant="primary" data-ready={allProcessesAssigned ? "true" : "false"} onClick={() => void confirmAssignments()} disabled={busy}>{busy ? "处理中…" : "完成分配，开始返工"}</Button>
        {!allProcessesAssigned && configItems.length > 0 && <p>每道工序至少分配一名人员后才能开始返工。</p>}
      </Surface>}
    </>}
    {effectiveTaskMode === "work_reporting" && <>
      {managerProgressView ? <div className="n04-progress-board">
        <div className="n04-progress-summary" aria-label="返工任务进度汇总">
          <strong>任务进度</strong>
          <span className="is-pending">未完成 {incompleteTasks.length}</span>
          <span className="is-completed">已完成 {completedTasks.length}</span>
          {activeAdjustmentWritable ? <button type="button" className="n04-add-worker" onClick={openActiveAddition} disabled={busy || configItems.length === 0}>新增员工</button> : null}
        </div>
        <div className="n04-process-list">
          {progressProcessGroups.map((group) => <ManagerProcessProgressGroup
            key={group.configurationItemId}
            group={group}
            reworkOrderId={loadedReworkOrderId}
            writable={workReportingWritable}
            expanded={expandedProcesses[group.configurationItemId] === true}
            removableTaskIds={removableActiveTaskIds}
            onToggle={() => setExpandedProcesses((current) => ({
              ...current,
              [group.configurationItemId]: current[group.configurationItemId] !== true,
            }))}
            onRemoveTask={setRemovalTask}
            {...(iePrecounts ? {
              iePrecounts,
              onIePrecountChanged: async () => { await reload(); await onOrderChanged?.(); },
            } : {})}
          />)}
          {progressProcessGroups.length === 0 ? <p className="n04-progress-empty">暂无返工任务。</p> : null}
        </div>
        {workReportingWritable && canAssign && incompleteTasks.length === 0 && completedTasks.length > 0 ? <div className="n04-completion-action">
          <Button variant="primary" onClick={() => void completeExecution()} disabled={busy}>{busy ? "核验中…" : "全部完成，进入节点05"}</Button>
        </div> : null}
      </div> : visibleTasks.map((task) => <Surface {...(frontlineContext ? { className: "frontline-work-task" } : {})} key={task.workTaskId}>
        <div className="section-title">
          <div>
            <h2>{taskProcessName(task)}</h2>
            <p>{task.executionKind === "tail_inspection" ? "整查人员" : "返工人员"}：{task.members.map((member) => member.displayName).join("、")}</p>
          </div>
          <StatusBadge tone={task.remainingQuantity === 0 ? "success" : workReportingWritable ? "warning" : "info"}>
            {task.remainingQuantity === 0 ? "已完成" : workReportingWritable ? "待上报" : "未完成"}
          </StatusBadge>
        </div>
        {task.unitPrice !== null ? <small className="work-reporting-approved-price">
          IE 核准单价：{formatBusinessCurrency(task.unitPrice)} / {task.pricingUnit === "piece" ? "件" : "小时"}
        </small> : null}
        <p>{task.remainingQuantity === 0 ? `已上报 ${formatBusinessDecimal(task.submittedQuantity)} 件` : workReportingWritable ? "按实际完成件数报数" : "该节点已结束"}</p>
        <ReturnedReportContext task={task} />
        {selfReportableTaskIds.has(task.workTaskId) ? <div className="mobile-actions work-reporting-actions">
          <Button variant="primary" onClick={() => openReporting([task])} disabled={busy}>
            {task.executionKind === "tail_inspection" ? "整查完成&报数" : "我已完工&上数"}
          </Button>
        </div> : null}
      </Surface>)}
      {reportableTasks.length > 0 && (isRoot || canAssign) && <Surface className="work-reporting-primary-action"><h2>{isRoot ? "代报数" : "临时工代报数"}</h2><p>{isRoot ? "为执行人员代录最终数量。" : "为临时工填写最终返工数量。正式工由本人逐工序确认上数。"}</p><Button variant="primary" onClick={() => openReporting(reportableTasks)} disabled={busy}>{isRoot ? "代为报数" : "临时工完工上数"}</Button></Surface>}
      {visibleTasks.length === 0 && <Surface>当前暂无需要本人处理的任务。</Surface>}
    </>}
    {removalTask && (assignmentWritable || activeAdjustmentWritable) && <div className="work-reporting-dialog-backdrop" role="presentation"><Surface className="work-reporting-dialog"><div role="dialog" aria-modal="true" aria-label="移除返工人员"><h2>移除返工人员</h2><p>确认从当前订单移除“{removalTask.members[0]?.displayName ?? "该人员"}”的“{removalTask.processName}”任务？</p><div className="mobile-actions work-reporting-actions"><Button onClick={() => setRemovalTask(null)} disabled={busy}>取消</Button><Button variant="primary" onClick={() => void confirmRemoval()} disabled={busy}>{busy ? "处理中…" : "确认移除"}</Button></div>{message ? <p role="status">{message}</p> : null}</div></Surface></div>}
    {adjustmentDialogOpen && activeAdjustmentWritable && <div className="work-reporting-dialog-backdrop" role="presentation"><Surface className="work-reporting-dialog"><div role="dialog" aria-modal="true" aria-label="新增返工员工"><h2>新增员工</h2><p>新增人员只加入当前订单，不修改默认人员名单。</p><div className="workforce-adjustment-processes" role="group" aria-label="选择工序">{configItems.map((item) => <Button key={item.configurationItemId} {...(adjustmentConfigurationItemId === item.configurationItemId ? { variant: "primary" as const } : {})} onClick={() => { setAdjustmentConfigurationItemId(item.configurationItemId); setSelected({}); }} disabled={busy}>{item.processName}</Button>)}</div><div className="workforce-type-tabs" role="tablist" aria-label="员工类别"><button type="button" role="tab" aria-selected={peopleType === "internal"} className={peopleType === "internal" ? "is-active" : ""} onClick={() => choosePeopleType("internal")} disabled={busy}>正式工</button><button type="button" role="tab" aria-selected={peopleType === "temporary"} className={peopleType === "temporary" ? "is-active" : ""} onClick={() => choosePeopleType("temporary")} disabled={busy}>临时工</button></div><InsetField label="搜索员工" type="search" value={peopleQuery} placeholder="输入姓名搜索" disabled={busy} onChange={(event) => setPeopleQuery(event.target.value)} /><div className="workforce-person-list">{filteredPeople.map((person) => <label className="process-source" key={person.personId}><input type="checkbox" checked={Boolean(selected[person.personId])} disabled={busy} onChange={(event) => setSelected((current) => ({ ...current, [person.personId]: event.target.checked }))} />{person.displayName}</label>)}</div>{filteredPeople.length === 0 ? <p>当前工序没有其他可新增员工。</p> : null}<div className="mobile-actions work-reporting-actions"><Button onClick={() => setAdjustmentDialogOpen(false)} disabled={busy}>取消</Button><Button variant="primary" data-ready={adjustmentSelectedCount > 0 ? "true" : "false"} onClick={() => void addActiveMembers()} disabled={busy}>{busy ? "新增中…" : `确认新增（${adjustmentSelectedCount}）`}</Button></div>{message ? <p role="status">{message}</p> : null}</div></Surface></div>}
    {temporaryDialogOpen && assignmentWritable && <div className="work-reporting-dialog-backdrop" role="presentation"><Surface className="work-reporting-dialog"><div role="dialog" aria-modal="true" aria-label="添加临时工"><h2>添加临时工</h2><InsetField label="姓名（必填）" value={temporaryName} maxLength={100} disabled={busy} onChange={(event) => setTemporaryName(event.target.value)} /><InsetField label="手机号（选填）" value={temporaryPhoneNumber} maxLength={30} inputMode="tel" disabled={busy} onChange={(event) => setTemporaryPhoneNumber(event.target.value)} /><InsetField label="身份证号（选填）" value={temporaryIdentityNumber} maxLength={18} disabled={busy} onChange={(event) => setTemporaryIdentityNumber(event.target.value)} /><InsetField label="区分备注（选填）" value={temporaryRemark} maxLength={100} disabled={busy} onChange={(event) => setTemporaryRemark(event.target.value)} /><div className="mobile-actions work-reporting-actions"><Button onClick={() => setTemporaryDialogOpen(false)} disabled={busy}>取消</Button><Button variant="primary" data-ready={temporaryName.trim() ? "true" : "false"} onClick={() => void createTemporaryWorker()} disabled={busy}>{busy ? "添加中…" : "添加临时工"}</Button></div>{message ? <p role="status">{message}</p> : null}</div></Surface></div>}
    {reportTasks && workReportingWritable && <div className="work-reporting-dialog-backdrop" role="presentation"><Surface className="work-reporting-dialog"><div role="dialog" aria-modal="true" aria-label="返工执行报数"><h2>{isRoot ? "请输入代报数的实际件数" : canAssign ? "请输入临时工的实际件数" : reportTasks.every((task) => task.executionKind === "tail_inspection") ? "请输入您的实际整查件数" : "请输入您的实际完工件数"}</h2>{reportTasks.map((task) => <div key={task.workTaskId}><ReturnedReportContext task={task} /><InsetField label={`${task.members.map((member) => member.displayName).join("、")} · ${task.processName}（件）`} type="number" min="1" step="1" inputMode="numeric" value={reportQuantities[task.workTaskId] ?? ""} disabled={busy} onChange={(event) => setReportQuantities((current) => ({ ...current, [task.workTaskId]: event.target.value }))} /></div>)}{!reportsReady && <p role="status">请把每项实际完工件数填写为大于 0 的整数。</p>}{busy && <p role="status">正在提交 {formatBusinessDecimal(reportTasks.length)} 项报数，请勿关闭页面或重复操作。</p>}<div className="mobile-actions work-reporting-actions"><Button onClick={() => setReportTasks(null)} disabled={busy}>返回返工</Button><Button variant="primary" data-ready={reportsReady ? "true" : "false"} onClick={() => void submitReports()} disabled={busy}>{busy ? reportTasks.length > 1 ? `批量提交中（${formatBusinessDecimal(reportTasks.length)} 项）…` : "提交中…" : "确认"}</Button></div>{message ? <p role="status">{message}</p> : null}</div></Surface></div>}
  </div>;
}
