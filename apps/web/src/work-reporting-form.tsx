import {
  ReworkWorkTasksResponseSchema,
  ProcessConfigurationResponseSchema,
  WorkTaskAssignablePeopleResponseSchema,
  WorkReportResponseSchema,
  WorkTaskResponseSchema,
  type ReworkWorkTasksResponse,
} from "@dx-rework/contracts";
import { Button, InsetField, StatusBadge, Surface } from "@dx-rework/ui";
import { useEffect, useRef, useState } from "react";

import { createWebUrls } from "../url-contract.js";
import { canAssignWork, type WorkReportingUser } from "./work-reporting-permissions.js";
import { reportAttempt, taskAttempt, workReportDraft, type PendingWorkReport, type PendingWorkTask, type WorkReportDraft } from "./work-reporting-submission.js";

const { apiUrl } = createWebUrls(import.meta.env.BASE_URL);
type Person = { personId: string; displayName: string; personType: "internal" | "temporary" };
type AuthMe = { status: "authorized" | "no_role"; user: WorkReportingUser };
const request = async <T,>(path: string, parse: (value: unknown) => T, init?: RequestInit): Promise<T> => {
  const response = await fetch(apiUrl(path), { credentials: "include", ...init, headers: { accept: "application/json", ...(init?.body ? { "content-type": "application/json" } : {}), ...init?.headers } });
  if (!response.ok) { const body = await response.json().catch(() => null) as { error?: { message?: string } } | null; throw new Error(body?.error?.message ?? "请求未完成，请稍后重试"); }
  return parse(await response.json());
};
export function WorkReportingForm() {
  const reworkOrderId = new URLSearchParams(window.location.search).get("rework");
  const [data, setData] = useState<ReworkWorkTasksResponse | null>(null);
  const [configItems, setConfigItems] = useState<Array<{ configurationItemId: string; processName: string }>>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [mode, setMode] = useState<"individual" | "collective">("individual");
  const [reportDrafts, setReportDrafts] = useState<Record<string, WorkReportDraft>>({});
  const [message, setMessage] = useState("正在加载任务…");
  const [busy, setBusy] = useState(false);
  const [canAssign, setCanAssign] = useState(false);
  const reportAttempts = useRef<Record<string, PendingWorkReport>>({});
  const taskAttempts = useRef<Record<string, PendingWorkTask>>({});
  const draftFor = (taskId: string): WorkReportDraft => workReportDraft(reportDrafts, taskId);
  const reload = async () => { if (!reworkOrderId) return; const loaded = await request("rework-orders/" + reworkOrderId + "/work-tasks", ReworkWorkTasksResponseSchema.parse); setData(loaded); setMessage(loaded.tasks.length ? "任务已加载；每次上数均独立留痕。" : "当前尚未分配任务。"); };
  useEffect(() => { if (!reworkOrderId) { setMessage("缺少返工单编号，请从待办进入。"); return; } const load = async () => { const me = await request("auth/me", (value) => value as AuthMe); const assignable = me.status === "authorized" && canAssignWork(me.user); setCanAssign(assignable); await reload(); if (!assignable) { setPeople([]); setConfigItems([]); return; } const [peopleResult, configuration] = await Promise.all([request("work-task-options", WorkTaskAssignablePeopleResponseSchema.parse), request("rework-orders/" + reworkOrderId + "/process-configuration", ProcessConfigurationResponseSchema.parse)]); setPeople(peopleResult.people); setConfigItems(configuration.configuration?.items.map((item) => ({ configurationItemId: item.configurationItemId, processName: item.processName })) ?? []); }; void load().catch((cause: unknown) => setMessage(cause instanceof Error ? cause.message : "任务加载失败")); }, [reworkOrderId]);
  const assign = async (configurationItemId: string) => { if (!data || busy) return; const members = people.filter((person) => selected[person.personId]).map((person) => ({ personId: person.personId })); const payload = { expectedOrderVersion: data.orderVersion, configurationItemId, mode, members }; const attempt = taskAttempt(taskAttempts.current[configurationItemId], payload, crypto.randomUUID); taskAttempts.current[configurationItemId] = attempt; setBusy(true); try { await request("rework-orders/" + data.reworkOrderId + "/work-tasks", WorkTaskResponseSchema.parse, { method: "POST", headers: { "idempotency-key": attempt.key }, body: JSON.stringify(payload) }); await reload(); delete taskAttempts.current[configurationItemId]; setMessage("任务已创建；成员名单会作为本版本快照保存。后续换人请新建版本，历史上数不重算。"); } catch (cause) { setMessage(cause instanceof Error ? cause.message : "任务分配失败"); } finally { setBusy(false); } };
  const personalShare = (result: ReturnType<typeof WorkReportResponseSchema.parse>) => result.memberShares[0]?.amount;
  const report = async (taskId: string) => {
    if (!data || busy) return;
    const draft = draftFor(taskId);
    setBusy(true);
    try {
      if (!draft.quantity.trim() || !draft.completedAt) throw new Error("请填写本次上数和完工时间");
      const completedAt = new Date(draft.completedAt);
      if (Number.isNaN(completedAt.getTime())) throw new Error("完工时间格式无效，请重新填写");
      const payload = { expectedOrderVersion: data.orderVersion, actualQuantity: Number(draft.quantity), completedAt: completedAt.toISOString() };
      const attempt = reportAttempt(reportAttempts.current[taskId], payload, crypto.randomUUID);
      reportAttempts.current[taskId] = attempt;
      const result = await request("work-tasks/" + taskId + "/reports", WorkReportResponseSchema.parse, { method: "POST", headers: { "idempotency-key": attempt.key }, body: JSON.stringify(payload) });
      await reload();
      delete reportAttempts.current[taskId];
      setReportDrafts((current) => { const { [taskId]: _completed, ...remaining } = current; return remaining; });
      const share = personalShare(result);
      setMessage(result.groupAmount === null && share !== undefined ? "上数已提交：你的本次分摊 ¥" + share.toFixed(8) + "。" : result.groupAmount === null ? "上数已提交；你的个人分摊已生成。" : "上数已提交：组总额 ¥" + result.groupAmount.toFixed(8) + "；成员快照分摊已生成，不会因后续换人反算。");
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "上数提交失败");
    } finally {
      setBusy(false);
    }
  };
  return <main className="mobile-page"><div className="mobile-hero"><div className="mobile-title"><h1>工人分配与上数</h1><StatusBadge tone="info">N04–N05</StatusBadge></div><p>{data?.reworkOrderId ?? "返工任务"}</p><StatusBadge tone="success">服务端原子校验剩余量 · 网络重试不重复记数</StatusBadge></div><Surface><h2>当前处理说明</h2><p>{message}</p></Surface>{data?.tasks.map((task) => <Surface key={task.workTaskId}><div className="section-title"><div><h2>{task.processName}</h2><p>{task.mode === "collective" ? "集体计件" : "个人计件"} · 计划 {task.plannedQuantity} {task.pricingUnit === "piece" ? "件" : "小时"} · 剩余 {task.remainingQuantity}</p></div><StatusBadge tone={task.remainingQuantity ? "warning" : "success"}>V{task.version}</StatusBadge></div><p>成员快照：{task.members.map((member) => member.displayName).join("、")}</p>{task.canSubmitReport ? <><InsetField label={task.pricingUnit === "piece" ? "本次上数（件）" : "本次上数（小时）"} value={draftFor(task.workTaskId).quantity} inputMode="decimal" onChange={(event) => setReportDrafts((current) => ({ ...current, [task.workTaskId]: { ...workReportDraft(current, task.workTaskId), quantity: event.target.value } }))} disabled={busy} /><InsetField label="完工时间" type="datetime-local" value={draftFor(task.workTaskId).completedAt} onChange={(event) => setReportDrafts((current) => ({ ...current, [task.workTaskId]: { ...workReportDraft(current, task.workTaskId), completedAt: event.target.value } }))} disabled={busy} /><div className="mobile-actions"><Button variant="primary" onClick={() => void report(task.workTaskId)} disabled={busy || !draftFor(task.workTaskId).quantity || !draftFor(task.workTaskId).completedAt}>提交上数</Button></div></> : <p>该任务当前仅供查看；内部人员任务须由本人上数，临时工任务由已授权人员代录。</p>}</Surface>)}{data && canAssign && <Surface><h2>创建任务</h2><p>同一工序可同时分给多人；个人任务只允许一人，集体任务按本次成员快照平均分摊组总额。</p><label className="process-source"><input type="radio" checked={mode === "individual"} onChange={() => setMode("individual")} disabled={busy} /> 个人计件</label><label className="process-source"><input type="radio" checked={mode === "collective"} onChange={() => setMode("collective")} disabled={busy} /> 集体计件</label>{people.map((person) => <label className="process-source" key={person.personId}><input type="checkbox" checked={Boolean(selected[person.personId])} onChange={(event) => setSelected((current) => ({ ...current, [person.personId]: event.target.checked }))} disabled={busy} /> {person.displayName} · {person.personType === "temporary" ? "临时工（代录）" : "内部人员"}</label>)}<div className="mobile-actions">{configItems.map((item) => <Button key={item.configurationItemId} onClick={() => void assign(item.configurationItemId)} disabled={busy}>为 {item.processName} 新建任务版本</Button>)}</div>{configItems.length === 0 && <p>未发现可供分配的已生效工序。</p>}</Surface>}</main>;
}
