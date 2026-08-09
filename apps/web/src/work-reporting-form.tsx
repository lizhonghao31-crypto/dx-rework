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

export function WorkReportingForm() {
  const reworkOrderId = new URLSearchParams(window.location.search).get("rework");
  const [data, setData] = useState<ReworkWorkTasksResponse | null>(null);
  const [configItems, setConfigItems] = useState<Array<{ configurationItemId: string; processName: string }>>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [peopleQuery, setPeopleQuery] = useState("");
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [mode, setMode] = useState<"individual" | "collective">("individual");
  const [reportDrafts, setReportDrafts] = useState<Record<string, WorkReportDraft>>({});
  const [message, setMessage] = useState("正在加载任务…");
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

  const reload = async () => {
    if (!reworkOrderId) return;
    const loaded = await request("rework-orders/" + reworkOrderId + "/work-tasks", ReworkWorkTasksResponseSchema.parse);
    setData(loaded);
    setMessage(loaded.tasks.length ? "任务已加载；每次上数均独立留痕。" : "当前尚未分配任务。");
  };

  useEffect(() => {
    if (!reworkOrderId) {
      setMessage("缺少返工单编号，请从返工单详情进入。");
      return;
    }
    const load = async () => {
      const me = await request("auth/me", (value) => value as AuthMe);
      const assignable = me.status === "authorized" && canAssignWork(me.user);
      const taskReadable = me.status === "authorized" && (
        assignable
        || (me.user.businessRoles?.includes("worker") && me.user.capabilities.includes("work:report"))
        || me.user.capabilities.includes("work:report_for_worker")
      );
      setCanAssign(assignable);
      setCanReadTasks(taskReadable);
      setReviewEligible(me.status === "authorized");
      if (!taskReadable) {
        setData(null);
        setPeople([]);
        setConfigItems([]);
        setMessage("可在下方处理整单审核或数量调整；工人任务仅向任务成员和已授权代录人展示。");
        return;
      }
      await reload();
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
    void load().catch((cause: unknown) => setMessage(cause instanceof Error ? cause.message : "任务加载失败"));
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
      setMessage("任务已创建；成员名单会作为本版本快照保存。后续换人请新建版本，历史上数不重算。");
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "任务分配失败");
    } finally {
      setBusy(false);
    }
  };

  const personalShare = (result: ReturnType<typeof WorkReportResponseSchema.parse>) => result.memberShares[0]?.amount;

  const report = async (taskId: string) => {
    if (!data || busy) return;
    const task = data.tasks.find((candidate) => candidate.workTaskId === taskId);
    if (!task) {
      setMessage("当前任务不存在或已刷新，请重新进入返工单。");
      return;
    }
    const draft = draftFor(taskId);
    if (!draft.quantity.trim() || !draft.completedAt) {
      setMessage("请填写本次上数和完工时间。");
      return;
    }
    const actualQuantity = Number(draft.quantity);
    if (!Number.isFinite(actualQuantity) || actualQuantity <= 0) {
      setMessage("本次上数必须是大于 0 的数字。");
      return;
    }
    if (!/^\d+(?:\.\d)?$/.test(draft.quantity.trim())) {
      setMessage("本次上数最多保留一位小数。");
      return;
    }
    if (actualQuantity > task.remainingQuantity) {
      setMessage(`本次上数不能超过当前剩余 ${task.remainingQuantity} ${task.pricingUnit === "piece" ? "件" : "小时"}；多人同时提交时仍以服务端最终校验为准。`);
      return;
    }
    const completedAt = new Date(draft.completedAt);
    if (Number.isNaN(completedAt.getTime())) {
      setMessage("完工时间格式无效，请重新填写。");
      return;
    }
    const now = Date.now();
    if (completedAt.getTime() > now) {
      setMessage("完工时间不能晚于现在。");
      return;
    }
    if (completedAt.getTime() < now - 7 * 24 * 60 * 60 * 1000) {
      setMessage("完工时间只能补录最近七天。");
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
      await reload();
      delete reportAttempts.current[taskId];
      setReportDrafts((current) => {
        const remaining = { ...current };
        delete remaining[taskId];
        return remaining;
      });
      const share = personalShare(result);
      setMessage(
        result.groupAmount === null && share !== undefined
          ? "上数已提交：你的本次分摊 ¥" + formatMoney(share) + "。"
          : result.groupAmount === null
            ? "上数已提交；你的个人分摊已生成。"
            : "上数已提交：组总额 ¥" + formatMoney(result.groupAmount) + "；成员快照已按 0.001 元做确定性尾差分配，后续换人不反算。",
      );
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "上数提交失败");
    } finally {
      setBusy(false);
    }
  };

  return <div className="mobile-page work-reporting-page">
    <div className="mobile-hero">
      <div className="mobile-title">
        <h1>工人分配与上数</h1>
        <StatusBadge tone="info">N04–N06</StatusBadge>
      </div>
      <p>当前返工任务</p>
      <StatusBadge tone="success">服务端原子校验剩余量 · 网络重试不重复记数</StatusBadge>
    </div>

    <Surface><h2>当前处理说明</h2><p>{message}</p></Surface>

    {data?.tasks.map((task) => <Surface key={task.workTaskId}>
      <div className="section-title">
        <div>
          <h2>{task.processName}</h2>
          <p>{task.mode === "collective" ? "集体计件" : "个人计件"} · 计划 {task.plannedQuantity} {task.pricingUnit === "piece" ? "件" : "小时"} · 剩余 {task.remainingQuantity} {task.pricingUnit === "piece" ? "件" : "小时"}</p>
        </div>
        <StatusBadge tone={task.remainingQuantity ? "warning" : "success"}>成员版本 V{task.version}</StatusBadge>
      </div>
      <p>成员快照：{task.members.map((member) => member.displayName).join("、")}</p>
      {task.canSubmitReport ? <>
        <InsetField
          label={task.pricingUnit === "piece" ? "本次上数（件）" : "本次上数（小时）"}
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
        <InsetField
          label="完工时间"
          type="datetime-local"
          value={draftFor(task.workTaskId).completedAt}
          onChange={(event) => setReportDrafts((current) => ({
            ...current,
            [task.workTaskId]: { ...workReportDraft(current, task.workTaskId), completedAt: event.target.value },
          }))}
          disabled={busy}
        />
        <div className="mobile-actions work-reporting-actions">
          <Button variant="primary" onClick={() => void report(task.workTaskId)} disabled={busy}>提交上数</Button>
        </div>
      </> : <p>该任务当前仅供查看；内部人员任务须由本人上数，临时工任务由已授权人员代录。</p>}
    </Surface>)}

    {reworkOrderId && reviewEligible && (
      <WholeOrderReviewPanel reworkOrderId={reworkOrderId} onChanged={() => canReadTasks ? reload() : Promise.resolve()} />
    )}

    {data && canAssign && <Surface>
      <h2>创建任务</h2>
      <p>同一工序可同时分给多人；个人任务只允许一人，集体任务按本次成员快照平均分摊组总额。</p>
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
        {configItems.map((item) => <Button key={item.configurationItemId} onClick={() => void assign(item.configurationItemId)} disabled={busy}>为 {item.processName} 新建任务版本</Button>)}
      </div>
      {configItems.length === 0 && <p>未发现可供分配的已生效工序。</p>}
    </Surface>}
  </div>;
}
