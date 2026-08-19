import {
  ProcessConfigurationResponseSchema,
  ReworkWorkTasksResponseSchema,
  WorkTaskAssignablePeopleResponseSchema,
  WorkTaskResponseSchema,
  WorkReportResponseSchema,
  type ReworkWorkTasksResponse,
} from "@dx-rework/contracts";
import { Button, InsetField, StatusBadge, Surface } from "@dx-rework/ui";
import { useEffect, useMemo, useState } from "react";

import { createWebUrls } from "../url-contract.js";
import { canAssignWork, type WorkReportingUser } from "./work-reporting-permissions.js";
import { WholeOrderReviewPanel } from "./whole-order-review-panel.js";
import "./work-reporting-form.css";

const { apiUrl } = createWebUrls(import.meta.env.BASE_URL);
type Person = { personId: string; displayName: string; personType: "internal" | "temporary" };
type Task = ReworkWorkTasksResponse["tasks"][number];
type AuthMe = { status: "authorized" | "no_role"; user: WorkReportingUser };

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

const canReviewOrder = (user: WorkReportingUser): boolean => user.isRoot === true || [
  "submission:audit", "quantity:adjust", "quantity:confirm", "process:review",
].some((capability) => user.capabilities.includes(capability));
const canReadWorkFacts = (user: WorkReportingUser): boolean =>
  canAssignWork(user)
  || (user.businessRoles?.includes("worker") === true && user.capabilities.includes("work:report"))
  || user.capabilities.includes("work:report_for_worker")
  || (user.businessRoles?.includes("owner_group") === true && user.capabilities.includes("business:read_all"));

export function WorkReportingForm({
  reworkOrderId: providedReworkOrderId,
  taskMode = "workspace",
  onOrderChanged,
}: {
  reworkOrderId?: string;
  taskMode?: "workspace" | "task_assignment" | "work_reporting" | "whole_order_review";
  onOrderChanged?: () => Promise<void> | void;
} = {}) {
  const reworkOrderId = providedReworkOrderId ?? new URLSearchParams(window.location.search).get("rework");
  const [data, setData] = useState<ReworkWorkTasksResponse | null>(null);
  const [configItems, setConfigItems] = useState<Array<{ configurationItemId: string; processName: string }>>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [peopleQuery, setPeopleQuery] = useState("");
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [reportTasks, setReportTasks] = useState<Task[] | null>(null);
  const [reportQuantities, setReportQuantities] = useState<Record<string, string>>({});
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [canAssign, setCanAssign] = useState(false);
  const [isRoot, setIsRoot] = useState(false);
  const [canReadTasks, setCanReadTasks] = useState(false);
  const [reviewEligible, setReviewEligible] = useState(false);

  const filteredPeople = useMemo(() => {
    const needle = peopleQuery.trim().toLocaleLowerCase("zh-CN");
    if (!needle) return people;
    return people.filter((person) => `${person.displayName} ${person.personType === "temporary" ? "临时工 代录" : "内部人员"}`.toLocaleLowerCase("zh-CN").includes(needle));
  }, [people, peopleQuery]);
  const reload = async (): Promise<ReworkWorkTasksResponse | null> => {
    if (!reworkOrderId) return null;
    const loaded = await request(`rework-orders/${reworkOrderId}/work-tasks`, ReworkWorkTasksResponseSchema.parse);
    setData(loaded);
    return loaded;
  };

  useEffect(() => {
    if (!reworkOrderId) { setMessage("请从当前节点工作台选择一张订单进入处理。"); return; }
    const load = async () => {
      const me = await request("auth/me", (value) => value as AuthMe);
      const assignable = me.status === "authorized" && canAssignWork(me.user);
      const root = me.status === "authorized" && me.user.isRoot === true;
      const taskReadable = me.status === "authorized" && canReadWorkFacts(me.user);
      const orderReviewable = me.status === "authorized" && canReviewOrder(me.user);
      setCanAssign(assignable); setIsRoot(root); setCanReadTasks(taskReadable); setReviewEligible(orderReviewable);
      const loaded = taskReadable ? await reload() : null;
      if (!taskReadable) setMessage(orderReviewable ? "当前岗位只处理尾部确认，不展示工人的个人上数。" : "当前岗位没有这个节点的处理权限。");
      const assignmentView = taskMode === "task_assignment" || (taskMode === "workspace" && loaded?.reworkStatus === "pending_task_assignment");
      if (!assignable || !assignmentView) return;
      const [peopleResult, configuration] = await Promise.all([
        request("work-task-options", WorkTaskAssignablePeopleResponseSchema.parse),
        request(`rework-orders/${reworkOrderId}/process-configuration`, ProcessConfigurationResponseSchema.parse),
      ]);
      setPeople(peopleResult.people);
      setConfigItems(configuration.configuration?.items.map((item) => ({ configurationItemId: item.configurationItemId, processName: item.processName })) ?? []);
    };
    void load().catch((cause: unknown) => setMessage(cause instanceof Error ? cause.message : "当前节点加载失败"));
  }, [reworkOrderId, taskMode]);

  const assign = async (configurationItemId: string) => {
    if (!data || busy) return;
    const memberIds = people.filter((person) => selected[person.personId]).map((person) => person.personId);
    if (memberIds.length === 0) { setMessage("请至少选择一名返工人员。"); return; }
    setBusy(true);
    try {
      for (const personId of memberIds) await request(`rework-orders/${data.reworkOrderId}/work-tasks`, WorkTaskResponseSchema.parse, {
        method: "POST", headers: { "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({ expectedOrderVersion: data.orderVersion, configurationItemId, mode: "individual", members: [{ personId }] }),
      });
      await reload(); setSelected({}); setMessage("人员已分配。各工序都分完后，再统一点击“开始返工”。");
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : "人员分配失败"); } finally { setBusy(false); }
  };

  const confirmAssignments = async () => {
    if (!data || busy) return;
    setBusy(true);
    try {
      await request(`rework-orders/${data.reworkOrderId}/work-tasks/confirm`, ReworkWorkTasksResponseSchema.parse, {
        method: "POST", headers: { "idempotency-key": crypto.randomUUID() }, body: JSON.stringify({ expectedOrderVersion: data.orderVersion }),
      });
      await reload(); setMessage("返工已开始。工人只需在真正完工后点击“我已完工&上数”。"); await onOrderChanged?.();
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : "无法开始返工"); } finally { setBusy(false); }
  };

  const openReporting = (tasks: Task[]) => {
    setReportTasks(tasks);
    setReportQuantities(Object.fromEntries(tasks.map((task) => [task.workTaskId, ""])));
  };
  const submitReports = async () => {
    if (!data || !reportTasks || busy) return;
    const quantities = reportTasks.map((task) => ({ task, text: reportQuantities[task.workTaskId]?.trim() ?? "" }));
    if (quantities.some(({ text }) => !/^\d+$/.test(text) || Number(text) <= 0)) { setMessage("请输入大于 0 的整数件数。"); return; }
    setBusy(true);
    try {
      for (const { task, text } of quantities) await request(`work-tasks/${task.workTaskId}/reports`, WorkReportResponseSchema.parse, {
        method: "POST", headers: { "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({ expectedOrderVersion: data.orderVersion, actualQuantity: Number(text) }),
      });
      const loaded = await reload(); setReportTasks(null);
      if (loaded?.reworkStatus === "pending_order_review") { setMessage("工人上数与尾查报数均已完成，已流转至 N07 · 尾部主管整单确认。"); await onOrderChanged?.(); }
      else setMessage("工人完工件数已确认；系统继续并行等待其他工人或尾查完成报数。");
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : "完工上数失败"); } finally { setBusy(false); }
  };

  const effectiveTaskMode = taskMode === "workspace"
    ? data?.reworkStatus === "pending_task_assignment" ? "task_assignment" : data?.reworkStatus === "pending_order_review" ? "whole_order_review" : "work_reporting"
    : taskMode;
  const pendingTasks = data?.tasks.filter((task) => data.reworkStatus === "in_progress" && task.canSubmitReport) ?? [];
  const temporaryTasks = pendingTasks.filter((task) => task.members.some((member) => member.personType === "temporary"));
  const reportableTasks = isRoot ? pendingTasks : canAssign ? temporaryTasks : pendingTasks;
  const allProcessesAssigned = configItems.length > 0 && configItems.every((item) => data?.tasks.some((task) => task.configurationItemId === item.configurationItemId));
  const selectedPeopleCount = people.filter((person) => selected[person.personId]).length;
  const reportsReady = Boolean(reportTasks?.length && reportTasks.every((task) => {
    const text = reportQuantities[task.workTaskId]?.trim() ?? "";
    return /^\d+$/.test(text) && Number(text) > 0;
  }));

  if (effectiveTaskMode === "whole_order_review") return <div className="mobile-page work-reporting-page">
    {!reviewEligible && <Surface>{message}</Surface>}
    {reworkOrderId && reviewEligible && <WholeOrderReviewPanel reworkOrderId={reworkOrderId} onChanged={async () => { if (canReadTasks) await reload(); await onOrderChanged?.(); }} />}
  </div>;

  return <div className="mobile-page work-reporting-page">
    <div className="mobile-hero"><div className="mobile-title"><h1>{effectiveTaskMode === "task_assignment" ? "分配返工人员" : "工人完工上数"}</h1><StatusBadge tone="info">{effectiveTaskMode === "task_assignment" ? "N04" : "N05"}</StatusBadge></div><p>{effectiveTaskMode === "task_assignment" ? "每名人员独立分配。全部分完后统一开始返工。" : "只填实际整数件数；尾查报数与本节点并行，不以计划数作为上数依据。"}</p></div>
    {message && <p className="work-reporting-feedback" role="status">{message}</p>}
    {effectiveTaskMode === "task_assignment" && data && <>
      {data.tasks.length > 0 && <Surface><h2>已分配人员</h2>{data.tasks.map((task) => <div className="section-title whole-order-row" key={task.workTaskId}><div><b>{task.processName}</b><p>{task.members.map((member) => member.displayName).join("、")}</p></div><StatusBadge tone="info">待开工</StatusBadge></div>)}</Surface>}
      {canAssign && <Surface><h2>选择人员并分配工序</h2><p>可同时选择多人；临时工由尾部主管代上数。</p>
        <InsetField label="搜索返工人员" type="search" value={peopleQuery} placeholder="输入姓名，或搜索“临时工”" disabled={busy} onChange={(event) => setPeopleQuery(event.target.value)} />
        {filteredPeople.map((person) => <label className="process-source" key={person.personId}><input type="checkbox" checked={Boolean(selected[person.personId])} disabled={busy} onChange={(event) => setSelected((current) => ({ ...current, [person.personId]: event.target.checked }))} />{person.displayName} · {person.personType === "temporary" ? "临时工（主管代录）" : "内部人员"}</label>)}
        {people.length === 0 && <p>当前没有可分配的人员；请先维护人员资料或工人权限。</p>}
        {selectedPeopleCount === 0 && people.length > 0 && <p>先选择至少一名返工人员，再分配到对应工序。</p>}
        <div className="mobile-actions work-reporting-actions">{configItems.map((item) => <Button key={item.configurationItemId} onClick={() => void assign(item.configurationItemId)} disabled={busy || selectedPeopleCount === 0}>分配 {item.processName}</Button>)}</div>
        <Button variant="primary" onClick={() => void confirmAssignments()} disabled={busy || !allProcessesAssigned}>{busy ? "处理中…" : "完成分配，开始返工"}</Button>
        {!allProcessesAssigned && configItems.length > 0 && <p>每道工序至少分配一名人员后才能开始返工。</p>}
      </Surface>}
    </>}
    {effectiveTaskMode === "work_reporting" && <>
      {data?.tasks.map((task) => <Surface key={task.workTaskId}><div className="section-title"><div><h2>{task.processName}</h2><p>返工人员：{task.members.map((member) => member.displayName).join("、")}</p></div><StatusBadge tone={task.remainingQuantity === 0 ? "success" : "warning"}>{task.remainingQuantity === 0 ? "已完工" : "返工中"}</StatusBadge></div><p>{task.remainingQuantity === 0 ? `已上数 ${task.submittedQuantity} 件` : "待本人按实际完成件数上数"}</p></Surface>)}
      {reportableTasks.length > 0 && <Surface className="work-reporting-primary-action"><h2>{isRoot ? "代上数" : canAssign ? "临时工代上数" : "我已返工完成"}</h2><p>{isRoot ? "为返工人员代录最终数量。" : canAssign ? "为临时工填写最终返工数量。正式工由本人确认上数。" : "确认后即视为本次返工完工；如还要继续返工，请先返回。"}</p><Button variant="primary" onClick={() => openReporting(reportableTasks)} disabled={busy}>{isRoot ? "代为完工上数" : canAssign ? "临时工完工上数" : "我已完工&上数"}</Button></Surface>}
      {data?.tasks.length === 0 && <Surface>当前暂无返工任务。</Surface>}
    </>}
    {reportTasks && <div className="work-reporting-dialog-backdrop" role="presentation"><Surface className="work-reporting-dialog"><div role="dialog" aria-modal="true" aria-label="工人完工上数"><h2>{isRoot ? "请输入代上数的实际件数" : canAssign ? "请输入临时工的实际件数" : "请输入您的实际完工件数"}</h2>{reportTasks.map((task) => <InsetField key={task.workTaskId} label={`${task.members.map((member) => member.displayName).join("、")} · ${task.processName}（件）`} type="number" min="1" step="1" inputMode="numeric" value={reportQuantities[task.workTaskId] ?? ""} disabled={busy} onChange={(event) => setReportQuantities((current) => ({ ...current, [task.workTaskId]: event.target.value }))} />)}{!reportsReady && <p role="status">请把每项实际完工件数填写为大于 0 的整数。</p>}<div className="mobile-actions work-reporting-actions"><Button onClick={() => setReportTasks(null)} disabled={busy}>返回返工</Button><Button variant="primary" onClick={() => void submitReports()} disabled={busy || !reportsReady}>{busy ? "确认中…" : "确认"}</Button></div></div></Surface></div>}
  </div>;
}
