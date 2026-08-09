import {
  ReworkWorkTasksResponseSchema,
  ProcessConfigurationResponseSchema,
  WorkTaskAssignablePeopleResponseSchema,
  WorkReportResponseSchema,
  WorkTaskResponseSchema,
  type ReworkWorkTasksResponse,
} from "@dx-rework/contracts";
import { Button, InsetField, StatusBadge, Surface } from "@dx-rework/ui";
import { useEffect, useMemo, useRef, useState } from "react";

import { createWebUrls } from "../url-contract.js";
import { canAssignWork, type WorkReportingUser } from "./work-reporting-permissions.js";
import { reportAttempt, taskAttempt, workReportDraft, type PendingWorkReport, type PendingWorkTask, type WorkReportDraft } from "./work-reporting-submission.js";
import { WholeOrderReviewPanel } from "./whole-order-review-panel.js";
import "./work-reporting-form.css";

const { apiUrl } = createWebUrls(import.meta.env.BASE_URL);
type Person = { personId: string; displayName: string; personType: "internal" | "temporary" };
type AuthMe = { status: "authorized" | "no_role"; user: WorkReportingUser };
const request = async <T,>(path: string, parse: (value: unknown) => T, init?: RequestInit): Promise<T> => {
  const response = await fetch(apiUrl(path), { credentials: "include", ...init, headers: { accept: "application/json", ...(init?.body ? { "content-type": "application/json" } : {}), ...init?.headers } });
  if (!response.ok) { const body = await response.json().catch(() => null) as { error?: { message?: string } } | null; throw new Error(body?.error?.message ?? "请求未完成，请稍后重试"); }
  return parse(await response.json());
};
const formatMoney = (value: number): string => value.toLocaleString("zh-CN", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const canReviewOrder = (user: WorkReportingUser): boolean => user.isRoot === true || [
  "submission:audit",
  "quantity:adjust",
  "quantity:confirm",
  "process:review",
].some((capability) => user.capabilities.includes(capability));

const canReadWorkFacts = (user: WorkReportingUser): boolean =>
  canAssignWork(user)
  || (user.businessRoles?.includes("worker") === true && user.capabilities.includes("work:report"))
  || user.capabilities.includes("work:report_for_worker")
  || (user.businessRoles?.includes("owner_group") === true && user.capabilities.includes("business:read_all"));

export function WorkReportingForm() {
  const reworkOrderId = new URLSearchParams(window.location.search).get("rework");
  const [data, setData] = useState<ReworkWorkTasksResponse | null>(null);
  const [configItems, setConfigItems] = useState<Array<{ configurationItemId: string; processName: string }>>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [peopleQuery, setPeopleQuery] = useState("");
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [mode, setMode] = useState<"individual" | "collective">("individual");
  const [reportDrafts, setReportDrafts] = useState<Record<string, WorkReportDraft>>({});
  const [message, setMessage] = useState("正在加载当前节点…");
  const [busy, setBusy] = useState(false);
  const [canAssign, setCanAssign] = useState(false);
  const [canReadTasks, setCanReadTasks] = useState(false);
  const [reviewEligible, setReviewEligible] = useState(false);
  const reportAttempts = useRef<Record<string, PendingWorkReport>>({});
  const taskAttempts = useRef<Record<string, PendingWorkTask>>({});
  const draftFor = (taskId: string): WorkReportDraft => workReportDraft(reportDrafts, taskId);

  const filteredPeople = useMemo(() => {
    const needle = peopleQuery.trim().toLocaleLowerCase("zh-CN");
    if (!needle) return people;
    return people.filter((person) => {
      const typeLabel = person.personType === "temporary" ? "临时工 代录" : "内部人员";
      return `${person.displayName} ${typeLabel}`.toLocaleLowerCase("zh-CN").includes(needle);
    });
  }, [people, peopleQuery]);

  const reload = async (): Promise<ReworkWorkTasksResponse | null> => {
    if (!reworkOrderId) return null;
    const loaded = await request("rework-orders/" + reworkOrderId + "/work-tasks", ReworkWorkTasksResponseSchema.parse);
    setData(loaded);
    if (loaded.reworkStatus === "pending_order_review") {
      setMessage("全部工序已经完成，订单已自动流转到 N06 · 待整单审核。工人无需继续填写。");
    } else if (loaded.tasks.length) {
      setMessage("计划数量是这道工序的目标；“本次完成数量”只登记这一次新完成的数量。例如计划 100 件，可分 40 + 60 两次登记。");
    } else {
      setMessage("当前尚未分配返工任务。");
    }
    return loaded;
  };

  useEffect(() => {
    if (!reworkOrderId) {
      setMessage("请从当前节点工作台选择一张订单进入处理。");
      return;
    }
    const load = async () => {
      const me = await request("auth/me", (value) => value as AuthMe);
      const assignable = me.status === "authorized" && canAssignWork(me.user);
      const taskReadable = me.status === "authorized" && canReadWorkFacts(me.user);
      const orderReviewable = me.status === "authorized" && canReviewOrder(me.user);
      setCanAssign(assignable);
      setCanReadTasks(taskReadable);
      setReviewEligible(orderReviewable);
      if (taskReadable) {
        await reload();
      } else {
        setData(null);
        setPeople([]);
        setConfigItems([]);
        setMessage(orderReviewable
          ? "当前岗位只处理整单确认或数量异常，不展示工人的个人完成登记。"
          : "当前岗位没有这个节点的处理权限。");
      }
      if (!assignable) {
        setPeople([]);
        setConfigItems([]);
        return;
      }
      const [peopleResult, configuration] = await Promise.all([
        request("work-task-options", WorkTaskAssignablePeopleResponseSchema.parse),
        request("rework-orders/" + reworkOrderId + "/process-configuration", ProcessConfigurationResponseSchema.parse),
      ]);
      setPeople(peopleResult.people);
      setConfigItems(configuration.configuration?.items.map((item) => ({
        configurationItemId: item.configurationItemId,
        processName: item.processName,
      })) ?? []);
    };
    void load().catch((cause: unknown) => setMessage(cause instanceof Error ? cause.message : "当前节点加载失败"));
  }, [reworkOrderId]);

  const changeMode = (nextMode: "individual" | "collective") => {
    if (nextMode === mode) return;
    setMode(nextMode);
    setSelected({});
  };

  const selectPerson = (personId: string, checked: boolean) => {
    if (mode === "individual") {
      setSelected(checked ? { [personId]: true } : {});
      return;
    }
    setSelected((current) => ({ ...current, [personId]: checked }));
  };

  const assign = async (configurationItemId: string) => {
    if (!data || busy) return;
    const members = people
      .filter((person) => selected[person.personId])
      .map((person) => ({ personId: person.personId }));
    if (members.length === 0) {
      setMessage("请至少选择一名返工人员。");
      return;
    }
    if (mode === "individual" && members.length !== 1) {
      setMessage("个人计件一次只能选择一名人员；多人作业请切换为集体计件。");
      return;
    }
    const payload = { expectedOrderVersion: data.orderVersion, configurationItemId, mode, members };
    const attempt = taskAttempt(taskAttempts.current[configurationItemId], payload, crypto.randomUUID);
    taskAttempts.current[configurationItemId] = attempt;
    setBusy(true);
    try {
      await request("rework-orders/" + data.reworkOrderId + "/work-tasks", WorkTaskResponseSchema.parse, {
        method: "POST",
        headers: { "idempotency-key": attempt.key },
        body: JSON.stringify(payload),
      });
      await reload();
      delete taskAttempts.current[configurationItemId];
      setMessage("人员已分配，订单已进入 N05 · 返工执行中。成员名单按本次版本留存，历史完成记录不会因后续换人重算。");
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "任务分配失败");
    } finally {
      setBusy(false);
    }
  };

  const personalShare = (result: ReturnType<typeof WorkReportResponseSchema.parse>) => result.memberShares[0]?.amount;

  const fillRemaining = (taskId: string, remainingQuantity: number) => {
    setReportDrafts((current) => ({
      ...current,
      [taskId]: {
        ...workReportDraft(current, taskId),
        quantity: String(remainingQuantity),
      },
    }));
  };

  const report = async (taskId: string) => {
    if (!data || busy) return;
    const task = data.tasks.find((candidate) => candidate.workTaskId === taskId);
    if (!task) {
      setMessage("当前任务不存在或已刷新，请重新进入这张订单。");
      return;
    }
    if (task.remainingQuantity <= 0 || !["pending_task_assignment", "in_progress"].includes(data.reworkStatus)) {
      setMessage("该工序已经完成或订单已流转到下一节点，不能继续登记完成数量。");
      return;
    }
    const draft = draftFor(taskId);
    if (!draft.quantity.trim() || !draft.completedAt) {
      setMessage("请填写本次完成数量和实际完成时间。");
      return;
    }
    const actualQuantity = Number(draft.quantity);
    if (!Number.isFinite(actualQuantity) || actualQuantity <= 0) {
      setMessage("本次完成数量必须是大于 0 的数字。");
      return;
    }
    if (!/^\d+(?:\.\d)?$/.test(draft.quantity.trim())) {
      setMessage("本次完成数量最多保留一位小数。");
      return;
    }
    if (actualQuantity > task.remainingQuantity) {
      setMessage(`本次完成数量不能超过当前剩余 ${task.remainingQuantity} ${task.pricingUnit === "piece" ? "件" : "小时"}。`);
      return;
    }
    const completedAt = new Date(draft.completedAt);
    if (Number.isNaN(completedAt.getTime())) {
      setMessage("实际完成时间格式无效，请重新填写。");
      return;
    }
    const now = Date.now();
    if (completedAt.getTime() > now) {
      setMessage("实际完成时间不能晚于现在。");
      return;
    }
    if (completedAt.getTime() < now - 7 * 24 * 60 * 60 * 1000) {
      setMessage("实际完成时间只能补录最近七天。");
      return;
    }

    setBusy(true);
    try {
      const payload = {
        expectedOrderVersion: data.orderVersion,
        actualQuantity,
        completedAt: completedAt.toISOString(),
      };
      const attempt = reportAttempt(reportAttempts.current[taskId], payload, crypto.randomUUID);
      reportAttempts.current[taskId] = attempt;
      const result = await request("work-tasks/" + taskId + "/reports", WorkReportResponseSchema.parse, {
        method: "POST",
        headers: { "idempotency-key": attempt.key },
        body: JSON.stringify(payload),
      });
      const loaded = await reload();
      delete reportAttempts.current[taskId];
      setReportDrafts((current) => {
        const remaining = { ...current };
        delete remaining[taskId];
        return remaining;
      });
      if (loaded?.reworkStatus === "pending_order_review") {
        setMessage("完成数量已登记；所有工序已经完成，订单已自动流转到 N06 · 待整单审核。");
        return;
      }
      const share = personalShare(result);
      setMessage(
        result.groupAmount === null && share !== undefined
          ? "完成数量已登记：你的本次计件金额 ¥" + formatMoney(share) + "。"
          : result.groupAmount === null
            ? "完成数量已登记；个人计件明细已生成。"
            : "完成数量已登记：组总额 ¥" + formatMoney(result.groupAmount) + "；本次成员快照已固定，后续换人不影响历史。",
      );
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "完成数量登记失败");
    } finally {
      setBusy(false);
    }
  };

  const orderReportingOpen = data && ["pending_task_assignment", "in_progress"].includes(data.reworkStatus);

  return <div className="mobile-page work-reporting-page">
    <div className="mobile-hero">
      <div className="mobile-title">
        <h1>返工分工与完成登记</h1>
        <StatusBadge tone="info">N04–N06</StatusBadge>
      </div>
      <p>订单按当前状态处理；工人只登记实际完成，主管只在对应节点做确认。</p>
      <StatusBadge tone="success">计划是目标 · 完成数量可分批登记 · 达到计划后自动停止登记</StatusBadge>
    </div>

    <Surface className="workflow-queue-guide">
      <div><small>谁来处理</small><strong>{data?.reworkStatus === "pending_order_review" ? "尾部主管" : canAssign ? "尾部主管 / 工人" : "工人 / 已授权代录人"}</strong></div>
      <div><small>当前要做什么</small><strong>{data?.reworkStatus === "pending_order_review" ? "确认本单所有返工已经完成" : canAssign ? "先分配人员，再按实际进度登记完成数量" : "登记自己这次实际完成的数量"}</strong></div>
      <div><small>完成后去哪里</small><strong>{data?.reworkStatus === "pending_order_review" ? "确认后进入 N07 · 责任判定" : "全部工序完成后自动进入 N06 · 整单审核"}</strong></div>
    </Surface>

    <Surface><h2>当前处理说明</h2><p>{message}</p></Surface>

    {data?.tasks.map((task) => {
      const unit = task.pricingUnit === "piece" ? "件" : "小时";
      const complete = task.remainingQuantity <= 0;
      const canEnterCompletion = Boolean(orderReportingOpen && task.canSubmitReport && !complete);
      return <Surface key={task.workTaskId}>
        <div className="section-title">
          <div>
            <h2>{task.processName}</h2>
            <p>{task.mode === "collective" ? "集体计件" : "个人计件"} · 计划 {task.plannedQuantity} {unit} · 已完成 {task.submittedQuantity} {unit} · 剩余 {task.remainingQuantity} {unit}</p>
          </div>
          <StatusBadge tone={complete ? "success" : "warning"}>{complete ? "该工序已完成" : `进行中 · V${task.version}`}</StatusBadge>
        </div>
        <p>返工人员：{task.members.map((member) => member.displayName).join("、")}</p>
        {canEnterCompletion ? <>
          <p><b>本次完成数量</b>只填写这一次新完成的数量，不是重复填写计划。例如计划 100 件，上午做 40 件就填 40，下午再做 60 件。</p>
          <InsetField
            label={`本次完成数量（${unit}）`}
            type="number"
            min="0.1"
            max={String(task.remainingQuantity)}
            step="0.1"
            value={draftFor(task.workTaskId).quantity}
            inputMode="decimal"
            onChange={(event) => setReportDrafts((current) => ({
              ...current,
              [task.workTaskId]: { ...workReportDraft(current, task.workTaskId), quantity: event.target.value },
            }))}
            disabled={busy}
          />
          <div className="mobile-actions work-reporting-actions">
            <Button onClick={() => fillRemaining(task.workTaskId, task.remainingQuantity)} disabled={busy}>全部完成剩余 {task.remainingQuantity} {unit}</Button>
          </div>
          <InsetField
            label="实际完成时间"
            type="datetime-local"
            value={draftFor(task.workTaskId).completedAt}
            onChange={(event) => setReportDrafts((current) => ({
              ...current,
              [task.workTaskId]: { ...workReportDraft(current, task.workTaskId), completedAt: event.target.value },
            }))}
            disabled={busy}
          />
          <p>实际完成时间是这批返工真正做完的时间。系统默认当前时间；只有补录最近七天的历史完成记录时才需要修改。</p>
          <div className="mobile-actions work-reporting-actions">
            <Button variant="primary" onClick={() => void report(task.workTaskId)} disabled={busy}>{busy ? "提交中…" : "登记本次完成数量"}</Button>
          </div>
        </> : complete ? (
          <p><b>该工序已完成。</b>系统已关闭继续登记入口；如业务数量确需变化，请由主管走“异常处理 → 数量调整”，不能继续追加完成数量。</p>
        ) : (
          <p>当前账号仅可查看该任务，或订单已经流转到下一节点；这里不再提供完成数量输入。</p>
        )}
      </Surface>;
    })}

    {data && canAssign && data.reworkStatus === "pending_task_assignment" && <Surface>
      <h2>N04 · 分配返工人员</h2>
      <p>这一步只负责把已生效工序分给实际返工人员。个人任务一次选择一人；集体任务按本次成员快照计算。</p>
      <label className="process-source"><input type="radio" checked={mode === "individual"} onChange={() => changeMode("individual")} disabled={busy} /> 个人计件</label>
      <label className="process-source"><input type="radio" checked={mode === "collective"} onChange={() => changeMode("collective")} disabled={busy} /> 集体计件</label>
      <InsetField
        label="搜索返工人员"
        type="search"
        value={peopleQuery}
        placeholder="输入姓名，或搜索“临时工”"
        disabled={busy}
        onChange={(event) => setPeopleQuery(event.target.value)}
      />
      {filteredPeople.map((person) => <label className="process-source" key={person.personId}>
        <input
          type={mode === "individual" ? "radio" : "checkbox"}
          name={mode === "individual" ? "individual-worker" : undefined}
          checked={Boolean(selected[person.personId])}
          onChange={(event) => selectPerson(person.personId, event.target.checked)}
          disabled={busy}
        />
        {person.displayName} · {person.personType === "temporary" ? "临时工（代录）" : "内部人员"}
      </label>)}
      {people.length > 0 && filteredPeople.length === 0 && <p>没有匹配的返工人员。</p>}
      {people.length === 0 && <p>当前没有可分配的返工人员；请先在人员资料或权限管理完成维护。</p>}
      <div className="mobile-actions work-reporting-actions">
        {configItems.map((item) => <Button key={item.configurationItemId} onClick={() => void assign(item.configurationItemId)} disabled={busy}>分配 {item.processName}</Button>)}
      </div>
      {configItems.length === 0 && <p>未发现可供分配的已生效工序。</p>}
    </Surface>}

    {reworkOrderId && reviewEligible && (
      <WholeOrderReviewPanel reworkOrderId={reworkOrderId} onChanged={() => canReadTasks ? reload().then(() => undefined) : Promise.resolve()} />
    )}
  </div>;
}
