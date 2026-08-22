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
  const [peopleType, setPeopleType] = useState<"internal" | "temporary">("internal");
  const [peopleQuery, setPeopleQuery] = useState("");
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [removalTask, setRemovalTask] = useState<Task | null>(null);
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
  const [canCreateTemporary, setCanCreateTemporary] = useState(false);
  const [isRoot, setIsRoot] = useState(false);
  const [canReadTasks, setCanReadTasks] = useState(false);
  const [reviewEligible, setReviewEligible] = useState(false);

  const filteredPeople = useMemo(() => {
    const typedPeople = people.filter((person) => person.personType === peopleType);
    const needle = peopleQuery.trim().toLocaleLowerCase("zh-CN");
    if (!needle) return typedPeople;
    return typedPeople.filter((person) => person.displayName.toLocaleLowerCase("zh-CN").includes(needle));
  }, [people, peopleQuery, peopleType]);

  const reload = async (): Promise<ReworkWorkTasksResponse | null> => {
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
    if (!reworkOrderId) { setMessage("请从当前节点工作台选择一张订单进入处理。"); return; }
    const load = async () => {
      const me = await request("auth/me", (value) => value as AuthMe);
      const assignable = me.status === "authorized" && canAssignWork(me.user);
      const root = me.status === "authorized" && me.user.isRoot === true;
      const taskReadable = me.status === "authorized" && canReadWorkFacts(me.user);
      const orderReviewable = me.status === "authorized" && canReviewOrder(me.user);
      const temporaryManageable = me.status === "authorized"
        && (root || me.user.capabilities.includes("temporary_worker:manage"));
      setCanAssign(assignable); setCanCreateTemporary(temporaryManageable); setIsRoot(root); setCanReadTasks(taskReadable); setReviewEligible(orderReviewable);
      const loaded = taskReadable ? await reload() : null;
      if (!taskReadable) setMessage(orderReviewable ? "当前岗位只处理尾部确认，不展示工人的个人上数。" : "当前岗位没有这个节点的处理权限。");
      const assignmentView = loaded?.reworkStatus === "pending_task_assignment"
        && (taskMode === "task_assignment" || taskMode === "workspace");
      if (!assignable || !assignmentView) return;
      const [, configuration] = await Promise.all([
        reloadPeople(),
        request(`rework-orders/${reworkOrderId}/process-configuration`, ProcessConfigurationResponseSchema.parse),
      ]);
      setConfigItems(configuration.configuration?.items.map((item) => ({ configurationItemId: item.configurationItemId, processName: item.processName })) ?? []);
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

  const confirmRemoval = async () => {
    if (!data || data.reworkStatus !== "pending_task_assignment" || !removalTask || busy) return;
    const workerName = removalTask.members[0]?.displayName ?? "该人员";
    setBusy(true);
    try {
      await requestNoContent(`work-tasks/${removalTask.workTaskId}/remove`, {
        method: "POST",
        headers: { "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({ expectedOrderVersion: data.orderVersion }),
      });
      await reload();
      setRemovalTask(null);
      setMessage(`已移除 ${workerName} 的错误分配。`);
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
    if (!displayName) { setMessage("请填写临时工姓名。"); return; }
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
    if (!data || data.reworkStatus !== "in_progress" || !reportTasks || busy) return;
    const quantities = reportTasks.map((task) => ({ task, text: reportQuantities[task.workTaskId]?.trim() ?? "" }));
    if (quantities.some(({ text }) => !/^\d+$/.test(text) || Number(text) <= 0)) { setMessage("请输入大于 0 的整数件数。"); return; }
    setBusy(true);
    try {
      for (const { task, text } of quantities) await request(`work-tasks/${task.workTaskId}/reports`, WorkReportResponseSchema.parse, {
        method: "POST", headers: { "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({ expectedOrderVersion: data.orderVersion, actualQuantity: Number(text) }),
      });
      const loaded = await reload(); setReportTasks(null);
      if (loaded?.reworkStatus === "pending_order_review") { setMessage("返工执行报数已全部完成，已流转至 N05 · 尾部最终数量确认。"); await onOrderChanged?.(); }
      else setMessage("本次执行报数已确认；系统继续等待其他返工人员或尾查完成。");
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : "完工上数失败"); } finally { setBusy(false); }
  };

  const effectiveTaskMode = taskMode === "workspace"
    ? data?.reworkStatus === "pending_task_assignment" ? "task_assignment" : ["pending_order_review", "pending_final_quantity_ie_review"].includes(data?.reworkStatus ?? "") ? "whole_order_review" : "work_reporting"
    : taskMode;
  const assignmentWritable = data?.reworkStatus === "pending_task_assignment";
  const workReportingWritable = data?.reworkStatus === "in_progress";
  const pendingTasks = data?.tasks.filter((task) => workReportingWritable && task.canSubmitReport) ?? [];
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
    <div className="mobile-hero"><div className="mobile-title"><h1>{effectiveTaskMode === "task_assignment" ? "历史人员分配" : "返工执行报数"}</h1><StatusBadge tone="info">{effectiveTaskMode === "task_assignment" ? "历史流程" : "N04"}</StatusBadge></div><p>{effectiveTaskMode === "task_assignment" ? "仅用于兼容旧订单；新订单已在节点02完成返工人员预分配。" : "返工人员与尾查都在本节点按本人任务填写实际整数件数。"}</p></div>
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
        <div className="mobile-actions work-reporting-actions">{configItems.map((item) => <Button key={item.configurationItemId} onClick={() => void assign(item.configurationItemId)} disabled={busy || selectedPeopleCount === 0}>分配 {item.processName}</Button>)}</div>
        <Button variant="primary" onClick={() => void confirmAssignments()} disabled={busy || !allProcessesAssigned}>{busy ? "处理中…" : "完成分配，开始返工"}</Button>
        {!allProcessesAssigned && configItems.length > 0 && <p>每道工序至少分配一名人员后才能开始返工。</p>}
      </Surface>}
    </>}
    {effectiveTaskMode === "work_reporting" && <>
      {data?.tasks.map((task) => <Surface key={task.workTaskId}><div className="section-title"><div><h2>{task.executionKind === "tail_inspection" ? "尾查" : task.processName}</h2><p>{task.executionKind === "tail_inspection" ? "尾查人员" : "返工人员"}：{task.members.map((member) => member.displayName).join("、")}</p></div><StatusBadge tone={task.remainingQuantity === 0 ? "success" : workReportingWritable ? "warning" : "info"}>{task.remainingQuantity === 0 ? "已报数" : workReportingWritable ? "执行中" : "已处理"}</StatusBadge></div><p>{task.remainingQuantity === 0 ? `已报数 ${task.submittedQuantity} 件` : workReportingWritable ? "待本人按实际完成件数报数" : "该节点已结束，仅保留历史分工与报数记录"}</p></Surface>)}
      {reportableTasks.length > 0 && <Surface className="work-reporting-primary-action"><h2>{isRoot ? "代报数" : canAssign ? "临时工代报数" : reportableTasks.every((task) => task.executionKind === "tail_inspection") ? "我已完成尾查" : "我已返工完成"}</h2><p>{isRoot ? "为执行人员代录最终数量。" : canAssign ? "为临时工填写最终返工数量。正式工由本人确认上数。" : reportableTasks.every((task) => task.executionKind === "tail_inspection") ? "填写本人实际尾查数量，提交后计入统一数量事实。" : "确认后即视为本次返工完工；如还要继续返工，请先返回。"}</p><Button variant="primary" onClick={() => openReporting(reportableTasks)} disabled={busy}>{isRoot ? "代为报数" : canAssign ? "临时工完工上数" : reportableTasks.every((task) => task.executionKind === "tail_inspection") ? "尾查完成&报数" : "我已完工&上数"}</Button></Surface>}
      {data?.tasks.length === 0 && <Surface>当前暂无返工任务。</Surface>}
    </>}
    {removalTask && assignmentWritable && <div className="work-reporting-dialog-backdrop" role="presentation"><Surface className="work-reporting-dialog"><div role="dialog" aria-modal="true" aria-label="移除返工人员"><h2>移除返工人员</h2><p>确认移除“{removalTask.members[0]?.displayName ?? "该人员"}”的“{removalTask.processName}”分配？</p><div className="mobile-actions work-reporting-actions"><Button onClick={() => setRemovalTask(null)} disabled={busy}>取消</Button><Button variant="primary" onClick={() => void confirmRemoval()} disabled={busy}>{busy ? "处理中…" : "确认移除"}</Button></div></div></Surface></div>}
    {temporaryDialogOpen && assignmentWritable && <div className="work-reporting-dialog-backdrop" role="presentation"><Surface className="work-reporting-dialog"><div role="dialog" aria-modal="true" aria-label="添加临时工"><h2>添加临时工</h2><InsetField label="姓名（必填）" value={temporaryName} maxLength={100} disabled={busy} onChange={(event) => setTemporaryName(event.target.value)} /><InsetField label="手机号（选填）" value={temporaryPhoneNumber} maxLength={30} inputMode="tel" disabled={busy} onChange={(event) => setTemporaryPhoneNumber(event.target.value)} /><InsetField label="身份证号（选填）" value={temporaryIdentityNumber} maxLength={18} disabled={busy} onChange={(event) => setTemporaryIdentityNumber(event.target.value)} /><InsetField label="区分备注（选填）" value={temporaryRemark} maxLength={100} disabled={busy} onChange={(event) => setTemporaryRemark(event.target.value)} /><div className="mobile-actions work-reporting-actions"><Button onClick={() => setTemporaryDialogOpen(false)} disabled={busy}>取消</Button><Button variant="primary" onClick={() => void createTemporaryWorker()} disabled={busy || !temporaryName.trim()}>{busy ? "添加中…" : "添加临时工"}</Button></div></div></Surface></div>}
    {reportTasks && workReportingWritable && <div className="work-reporting-dialog-backdrop" role="presentation"><Surface className="work-reporting-dialog"><div role="dialog" aria-modal="true" aria-label="返工执行报数"><h2>{isRoot ? "请输入代报数的实际件数" : canAssign ? "请输入临时工的实际件数" : reportTasks.every((task) => task.executionKind === "tail_inspection") ? "请输入您的实际尾查件数" : "请输入您的实际完工件数"}</h2>{reportTasks.map((task) => <InsetField key={task.workTaskId} label={`${task.members.map((member) => member.displayName).join("、")} · ${task.processName}（件）`} type="number" min="1" step="1" inputMode="numeric" value={reportQuantities[task.workTaskId] ?? ""} disabled={busy} onChange={(event) => setReportQuantities((current) => ({ ...current, [task.workTaskId]: event.target.value }))} />)}{!reportsReady && <p role="status">请把每项实际完工件数填写为大于 0 的整数。</p>}<div className="mobile-actions work-reporting-actions"><Button onClick={() => setReportTasks(null)} disabled={busy}>返回返工</Button><Button variant="primary" onClick={() => void submitReports()} disabled={busy || !reportsReady}>{busy ? "确认中…" : "确认"}</Button></div></div></Surface></div>}
  </div>;
}
