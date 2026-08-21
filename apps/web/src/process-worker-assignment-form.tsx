import {
  ProcessConfigurationOptionsResponseSchema,
  ProcessConfigurationResponseSchema,
  TailInspectionOptionsResponseSchema,
  WorkTaskAssignablePeopleResponseSchema,
  type ProcessConfigurationOptionsResponse,
  type ProcessConfigurationResponse,
  type TailInspectionOptionsResponse,
  type WorkTaskAssignablePeopleResponse,
} from "@dx-rework/contracts";
import {
  ProcessWorkerPlanActivationResponseSchema,
  ProcessWorkerPlanResponseSchema,
  type ProcessWorkerPlanResponse,
} from "@dx-rework/contracts/process-worker-plan";
import { Button, InsetField, StatusBadge, Surface } from "@dx-rework/ui";
import { useEffect, useMemo, useRef, useState } from "react";

import { createWebUrls } from "../url-contract.js";
import { LegacyProcessConfigurationForm } from "./legacy-process-configuration-form.js";
import { SearchSelect } from "./search-select.js";
import { confirmInApp } from "./system-dialog.js";
import { WorkReportingForm } from "./work-reporting-form.js";
import "./process-worker-assignment-form.css";

const { apiUrl } = createWebUrls(import.meta.env.BASE_URL);

type User = Readonly<{ id: string; businessRoles?: readonly string[]; capabilities: readonly string[]; isRoot?: boolean }>;
type Detail = Readonly<{
  createdBy: { userId: string; displayName: string };
  processConfigurationCreatedBy: { userId: string; displayName: string } | null;
}>;
type Person = WorkTaskAssignablePeopleResponse["people"][number];
type ItemForm = Readonly<{ source: "catalog" | "custom"; processId: string; customProcessName: string; unitPrice: string }>;
type TailInspectorSelection = Readonly<{ userId: string; boxScope: string }>;
type PendingSubmit = Readonly<{
  reworkOrderId: string;
  body: { expectedOrderVersion: number; expectedConfigurationVersion: number; tailInspectors: Array<Readonly<{ userId: string; boxScope?: string }>> };
  key: string;
}>;

const emptyItem = (): ItemForm => ({ source: "catalog", processId: "", customProcessName: "", unitPrice: "" });
const formatPrice = (value: number | null): string => value === null ? "" : value.toFixed(3).replace(/\.?0+$/, "");
const toItem = (item: NonNullable<ProcessConfigurationResponse["configuration"]>["items"][number]): ItemForm => ({
  source: item.source,
  processId: item.processId ?? "",
  customProcessName: item.source === "custom" ? item.processName : "",
  unitPrice: formatPrice(item.unitPrice),
});
const threeDecimals = /^\d+(?:\.\d{1,3})?$/;
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
const validateItems = (items: readonly ItemForm[]): string | null => {
  if (items.length === 0) return "至少需要配置一道工序";
  for (const [index, item] of items.entries()) {
    const label = `工序 ${index + 1}`;
    if (item.source === "catalog" && !item.processId) return `${label}：请选择公共工序`;
    if (item.source === "custom" && !item.customProcessName.trim()) return `${label}：请输入自定义工序名称`;
    if (!item.unitPrice.trim()) return `${label}：请输入候选单价`;
    if (!threeDecimals.test(item.unitPrice.trim()) || Number(item.unitPrice) < 0.001) return `${label}：单价最低 0.001 元，最多三位小数`;
  }
  return null;
};

export function ProcessWorkerAssignmentForm({ reworkOrderId, onOrderChanged }: {
  reworkOrderId: string;
  onOrderChanged?: () => Promise<void> | void;
}) {
  const [user, setUser] = useState<User | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [response, setResponse] = useState<ProcessConfigurationResponse | null>(null);
  const [plan, setPlan] = useState<ProcessWorkerPlanResponse | null>(null);
  const [processOptions, setProcessOptions] = useState<ProcessConfigurationOptionsResponse["processes"]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [tailOptions, setTailOptions] = useState<TailInspectionOptionsResponse["inspectors"]>([]);
  const [items, setItems] = useState<ItemForm[]>([emptyItem()]);
  const [workerIds, setWorkerIds] = useState<Record<string, string[]>>({});
  const [tailInspectors, setTailInspectors] = useState<TailInspectorSelection[]>([]);
  const [reviewReason, setReviewReason] = useState("");
  const [message, setMessage] = useState("正在加载分配工序与工人…");
  const [busy, setBusy] = useState(false);
  const [temporaryDialogOpen, setTemporaryDialogOpen] = useState(false);
  const [temporaryName, setTemporaryName] = useState("");
  const [temporaryRemark, setTemporaryRemark] = useState("");
  const pendingKeys = useRef<Record<string, string>>({});
  const pendingSubmit = useRef<PendingSubmit | null>(null);

  const canConfigure = user?.isRoot === true || Boolean(
    user?.businessRoles?.includes("tail_supervisor")
    && user.capabilities.includes("process:configure")
    && user.capabilities.includes("work:assign"),
  );
  const canReview = user?.isRoot === true || Boolean(user?.businessRoles?.includes("ie_reviewer") && user.capabilities.includes("process:review"));
  const canCreateTemporary = user?.isRoot === true || user?.capabilities.includes("temporary_worker:manage") === true;
  const configuration = response?.configuration ?? null;
  const editable = Boolean(canConfigure && response?.reworkStatus === "pending_process_configuration");
  const reviewBlocked = Boolean(user && user.isRoot !== true && detail && (user.id === detail.createdBy.userId || user.id === detail.processConfigurationCreatedBy?.userId));
  const reviewable = Boolean(canReview && response?.reworkStatus === "pending_ie_review" && !reviewBlocked);
  const itemIssue = validateItems(items);
  const workerIssue = items.findIndex((_, index) => (workerIds[String(index)] ?? []).length === 0);
  const readinessIssues = [
    ...(itemIssue ? [itemIssue] : []),
    ...(workerIssue >= 0 ? [`工序 ${workerIssue + 1} 至少分配 1 名工人`] : []),
    ...(tailInspectors.length === 0 ? ["至少分配 1 名尾查"] : []),
  ];
  const saveReady = editable && itemIssue === null && workerIssue < 0;
  const submitReady = saveReady && tailInspectors.length > 0;

  const mutationKey = (signature: string): string => {
    const existing = pendingKeys.current[signature]; if (existing) return existing;
    const next = crypto.randomUUID(); pendingKeys.current[signature] = next; return next;
  };
  const hydrate = (config: ProcessConfigurationResponse, workerPlan: ProcessWorkerPlanResponse) => {
    setResponse(config); setPlan(workerPlan);
    if (config.configuration) {
      setItems(config.configuration.items.map(toItem));
      const nextWorkers: Record<string, string[]> = {};
      config.configuration.items.forEach((item, index) => {
        nextWorkers[String(index)] = workerPlan.assignments.find((assignment) => assignment.configurationItemId === item.configurationItemId)?.members.map((member) => member.personId) ?? [];
      });
      setWorkerIds(nextWorkers);
    }
  };
  const loadCore = async () => {
    const [me, config, workerPlan, loadedDetail] = await Promise.all([
      request("auth/me", (value) => value as { status: string; user: User }),
      request(`rework-orders/${reworkOrderId}/process-configuration`, ProcessConfigurationResponseSchema.parse),
      request(`rework-orders/${reworkOrderId}/process-worker-plan`, ProcessWorkerPlanResponseSchema.parse),
      request(`rework-orders/${reworkOrderId}/business-detail`, (value) => value as Detail),
    ]);
    setUser(me.user); setDetail(loadedDetail); hydrate(config, workerPlan);
    const configurable = me.user.isRoot === true || Boolean(me.user.businessRoles?.includes("tail_supervisor") && me.user.capabilities.includes("process:configure") && me.user.capabilities.includes("work:assign"));
    if (configurable && config.reworkStatus === "pending_process_configuration") {
      const [processes, workers, tails] = await Promise.all([
        request("rework-process-configurations/options", ProcessConfigurationOptionsResponseSchema.parse),
        request("work-task-options", WorkTaskAssignablePeopleResponseSchema.parse),
        request("tail-inspection-options", TailInspectionOptionsResponseSchema.parse),
      ]);
      setProcessOptions(processes.processes); setPeople(workers.people); setTailOptions(tails.inspectors);
    }
    setMessage("");
  };
  useEffect(() => { void loadCore().catch((error: unknown) => setMessage(error instanceof Error ? error.message : "当前节点加载失败")); }, [reworkOrderId]);

  const setItem = (index: number, next: Partial<ItemForm>) => { setItems((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, ...next } : item)); pendingSubmit.current = null; };
  const addWorker = (index: number, personId: string) => {
    if (!personId) return;
    setWorkerIds((current) => { const key = String(index); const existing = current[key] ?? []; return existing.includes(personId) ? current : { ...current, [key]: [...existing, personId] }; });
    pendingSubmit.current = null;
  };
  const removeWorker = (index: number, personId: string) => { setWorkerIds((current) => ({ ...current, [String(index)]: (current[String(index)] ?? []).filter((id) => id !== personId) })); pendingSubmit.current = null; };

  const persistMergedDraft = async (): Promise<ProcessConfigurationResponse> => {
    if (!response || !editable || itemIssue || workerIssue >= 0) throw new Error("请先补完整工序和人员分配");
    const configBody = {
      expectedOrderVersion: response.orderVersion,
      items: items.map((item) => ({ source: item.source, ...(item.source === "catalog" ? { processId: item.processId } : { customProcessName: item.customProcessName.trim() }), plannedQuantity: 1, pricingUnit: "piece" as const, unitPrice: Number(item.unitPrice) })),
    };
    const configSignature = `config:${JSON.stringify(configBody)}`;
    const saved = await request(`rework-orders/${reworkOrderId}/process-configuration/draft`, ProcessConfigurationResponseSchema.parse, { method: "PUT", headers: { "idempotency-key": mutationKey(configSignature) }, body: JSON.stringify(configBody) });
    delete pendingKeys.current[configSignature];
    const savedConfiguration = saved.configuration;
    if (!savedConfiguration || savedConfiguration.status !== "draft" || savedConfiguration.items.length !== items.length) throw new Error("工序保存后的版本异常，请刷新后重试");
    const planBody = {
      expectedOrderVersion: saved.orderVersion,
      configurationId: savedConfiguration.configurationId,
      expectedConfigurationVersion: savedConfiguration.configurationVersion,
      assignments: savedConfiguration.items.map((item, index) => ({ configurationItemId: item.configurationItemId, memberIds: workerIds[String(index)] ?? [] })),
    };
    const planSignature = `plan:${JSON.stringify(planBody)}`;
    const savedPlan = await request(`rework-orders/${reworkOrderId}/process-worker-plan`, ProcessWorkerPlanResponseSchema.parse, { method: "PUT", headers: { "idempotency-key": mutationKey(planSignature) }, body: JSON.stringify(planBody) });
    delete pendingKeys.current[planSignature]; hydrate(saved, savedPlan); return saved;
  };
  const save = async () => {
    if (!saveReady || busy) return;
    setBusy(true); try { await persistMergedDraft(); setMessage("工序与工人已保存；人员会在 IE 核价通过后自动生效。"); }
    catch (error: unknown) { setMessage(error instanceof Error ? error.message : "工序与工人保存失败"); } finally { setBusy(false); }
  };
  const submit = async () => {
    if (!submitReady || busy) return;
    if (!(await confirmInApp("确认提交当前工序、候选单价和预分配工人给 IE 核价？"))) return;
    setBusy(true);
    try {
      let attempt = pendingSubmit.current;
      if (!attempt) {
        const saved = await persistMergedDraft(); const savedConfiguration = saved.configuration; if (!savedConfiguration) throw new Error("工序配置不存在");
        attempt = { reworkOrderId, body: { expectedOrderVersion: saved.orderVersion, expectedConfigurationVersion: savedConfiguration.configurationVersion, tailInspectors: tailInspectors.map((inspector) => ({ userId: inspector.userId, ...(inspector.boxScope.trim() ? { boxScope: inspector.boxScope.trim() } : {}) })) }, key: crypto.randomUUID() };
        pendingSubmit.current = attempt;
      }
      const submitted = await request(`rework-orders/${reworkOrderId}/process-configuration/submit`, ProcessConfigurationResponseSchema.parse, { method: "POST", headers: { "idempotency-key": attempt.key }, body: JSON.stringify(attempt.body) });
      pendingSubmit.current = null; setResponse(submitted); setMessage("已提交 IE 核价；工人方案已锁定，IE 通过后自动开始返工。"); await onOrderChanged?.();
    } catch (error: unknown) { setMessage(error instanceof Error ? error.message : "提交 IE 核价失败"); } finally { setBusy(false); }
  };
  const review = async (decision: "approved" | "rejected") => {
    if (!response || !configuration || !reviewable || busy) return;
    if (decision === "rejected" && !reviewReason.trim()) { setMessage("IE 驳回必须填写原因"); return; }
    if (!(await confirmInApp(decision === "approved" ? "确认核价通过？通过后预分配工人自动生效并开始返工。" : "确认驳回并退回尾部主管修改？"))) return;
    setBusy(true);
    try {
      const reviewBody = { expectedOrderVersion: response.orderVersion, expectedConfigurationVersion: configuration.configurationVersion, decision, reason: reviewReason.trim() || undefined };
      const reviewSignature = `review:${JSON.stringify(reviewBody)}`;
      const reviewed = await request(`rework-orders/${reworkOrderId}/process-configuration/review`, ProcessConfigurationResponseSchema.parse, { method: "POST", headers: { "idempotency-key": mutationKey(reviewSignature) }, body: JSON.stringify(reviewBody) });
      delete pendingKeys.current[reviewSignature];
      const latestPlan = await request(`rework-orders/${reworkOrderId}/process-worker-plan`, ProcessWorkerPlanResponseSchema.parse); hydrate(reviewed, latestPlan);
      setMessage(decision === "approved" ? reviewed.reworkStatus === "in_progress" ? "IE 已通过；预分配工人已自动生效，返工开始。" : "IE 已通过；自动启动未完成，尾部主管可在本节点重试启动。" : "IE 已驳回，等待尾部主管重新配置工序与工人。");
      await onOrderChanged?.();
    } catch (error: unknown) { setMessage(error instanceof Error ? error.message : "IE 核价提交失败"); } finally { setBusy(false); }
  };
  const recoverActivation = async () => {
    if (!response || !plan?.configurationVersion || busy) return;
    setBusy(true);
    try {
      await request(`rework-orders/${reworkOrderId}/process-worker-plan/activate`, ProcessWorkerPlanActivationResponseSchema.parse, { method: "POST", headers: { "idempotency-key": crypto.randomUUID() }, body: JSON.stringify({ expectedOrderVersion: response.orderVersion, expectedConfigurationVersion: plan.configurationVersion }) });
      setMessage("预分配工人已生效，返工开始。"); await onOrderChanged?.();
    } catch (error: unknown) { setMessage(error instanceof Error ? error.message : "返工启动失败"); } finally { setBusy(false); }
  };
  const reloadPeople = async () => { const workers = await request("work-task-options", WorkTaskAssignablePeopleResponseSchema.parse); setPeople(workers.people); };
  const createTemporaryWorker = async () => {
    const name = temporaryName.trim(); const remark = temporaryRemark.trim(); if (!canCreateTemporary || busy || !name) return;
    setBusy(true);
    try {
      await request("master-data/temporary-workers", (value) => value as { personId: string }, { method: "POST", body: JSON.stringify({ personType: "temporary", displayName: name, aliases: [], reason: "N02 分配工序&工人现场新增临时工", ...(remark ? { temporaryRemark: remark } : {}) }) });
      await reloadPeople(); setTemporaryName(""); setTemporaryRemark(""); setTemporaryDialogOpen(false); setMessage(`临时工 ${name} 已添加，可直接分配。`);
    } catch (error: unknown) { setMessage(error instanceof Error ? error.message : "临时工添加失败"); } finally { setBusy(false); }
  };

  const peopleOptions = useMemo(() => people.map((person) => ({ value: person.personId, label: `${person.displayName}${person.personType === "temporary" ? " · 临时工" : ""}`, keywords: `${person.displayName} ${person.personType === "temporary" ? "临时工" : "正式工"}` })), [people]);
  const peopleById = useMemo(() => new Map(people.map((person) => [person.personId, person])), [people]);
  const changedProps = onOrderChanged ? { onOrderChanged } : {};

  if (!response || !plan) return <Surface>{message || "正在加载…"}</Surface>;
  if (configuration && plan.required === false) {
    if (response.reworkStatus === "pending_task_assignment") return <WorkReportingForm reworkOrderId={reworkOrderId} taskMode="task_assignment" {...changedProps} />;
    return <LegacyProcessConfigurationForm reworkOrderId={reworkOrderId} {...changedProps} />;
  }
  if (response.reworkStatus === "pending_task_assignment") {
    return <Surface className="process-worker-recovery"><StatusBadge tone="warning">IE 已通过</StatusBadge><h2>预分配人员等待启动</h2><p>正常情况下 IE 通过后会自动开始返工；本单未自动启动，可由尾部主管重试，不需要重新选人。</p><PlanReadonly plan={plan} />{canConfigure ? <Button variant="primary" disabled={busy} onClick={() => void recoverActivation()}>{busy ? "启动中…" : "重试开始返工"}</Button> : null}{message ? <p role="status">{message}</p> : null}</Surface>;
  }
  if (editable) {
    return <div className="process-worker-page">
      <div className="mobile-hero"><div className="mobile-title"><h1>分配工序&工人</h1><StatusBadge tone="info">N02</StatusBadge></div><p>每道工序同时确定候选单价和返工人员；IE 只核价，通过后人员自动生效。</p></div>
      <Surface>
        <div className="section-title"><div><h2>工序与人员</h2><p>不填计划数量；每道工序至少 1 人，可多人。</p></div><Button disabled={busy} onClick={() => { setItems((current) => [...current, emptyItem()]); setWorkerIds((current) => ({ ...current, [String(items.length)]: [] })); }}>增加工序</Button></div>
        <div className="process-worker-lines">{items.map((item, index) => { const selectedIds = workerIds[String(index)] ?? []; return <section className="process-worker-line" key={index}>
          <div className="process-worker-line__heading"><b>工序 {index + 1}</b>{items.length > 1 ? <Button disabled={busy} onClick={() => { setItems((current) => current.filter((_, itemIndex) => itemIndex !== index)); setWorkerIds((current) => Object.fromEntries(items.filter((_, itemIndex) => itemIndex !== index).map((_, newIndex) => { const oldIndex = newIndex >= index ? newIndex + 1 : newIndex; return [String(newIndex), current[String(oldIndex)] ?? []]; }))); }}>删除</Button> : null}</div>
          <div className="process-worker-fields"><div className="process-worker-source"><label><input type="radio" checked={item.source === "catalog"} disabled={busy} onChange={() => setItem(index, { source: "catalog", customProcessName: "" })} /> 公共工序</label><label><input type="radio" checked={item.source === "custom"} disabled={busy} onChange={() => setItem(index, { source: "custom", processId: "" })} /> 自定义工序</label></div>
            {item.source === "catalog" ? <label className="dx-field"><span>返工工序</span><span className="dx-field__control search-select-control"><SearchSelect options={processOptions.map((process) => ({ value: process.processId, label: process.processName }))} value={item.processId} placeholder="搜索工序" emptyText="没有匹配工序" disabled={busy} onChange={(processId) => setItem(index, { processId })} /></span></label> : <InsetField label="自定义工序" value={item.customProcessName} disabled={busy} onChange={(event) => setItem(index, { customProcessName: event.target.value })} />}
            <InsetField label="候选单价（元/件）" type="number" min="0.001" step="0.001" inputMode="decimal" value={item.unitPrice} disabled={busy} onChange={(event) => setItem(index, { unitPrice: event.target.value })} />
          </div>
          <div className="process-worker-picker"><div><b>返工人员 *</b><small>{selectedIds.length ? `已选 ${selectedIds.length} 人` : "至少选择 1 人"}</small></div><div className="process-worker-chips">{selectedIds.map((personId) => { const person = peopleById.get(personId); return <span key={personId}>{person?.displayName ?? "人员"}{person?.personType === "temporary" ? " · 临时工" : ""}<button type="button" disabled={busy} onClick={() => removeWorker(index, personId)}>×</button></span>; })}</div><SearchSelect options={peopleOptions.filter((option) => !selectedIds.includes(option.value))} value="" placeholder="搜索并添加工人" emptyText="没有匹配人员" disabled={busy} onChange={(personId) => addWorker(index, personId)} /></div>
        </section>; })}</div>
        {canCreateTemporary ? <div className="process-worker-temp-entry"><Button disabled={busy} onClick={() => setTemporaryDialogOpen(true)}>＋ 新增临时工</Button></div> : null}
      </Surface>
      <Surface><div className="section-title"><div><h2>分配尾查</h2><p>本轮暂沿用现有尾查逻辑；查箱计件会在下一 PR 合并。</p></div><StatusBadge tone={tailInspectors.length ? "success" : "warning"}>{tailInspectors.length ? `已选 ${tailInspectors.length} 人` : "至少 1 人"}</StatusBadge></div><div className="process-worker-tail-list">{tailOptions.map((inspector) => { const selected = tailInspectors.find((item) => item.userId === inspector.userId); return <div key={inspector.userId}><label><input type="checkbox" checked={Boolean(selected)} disabled={busy} onChange={(event) => setTailInspectors((current) => event.target.checked ? [...current, { userId: inspector.userId, boxScope: "" }] : current.filter((item) => item.userId !== inspector.userId))} /> {inspector.displayName}</label>{selected ? <InsetField label="清点箱数/范围（可选）" value={selected.boxScope} disabled={busy} onChange={(event) => setTailInspectors((current) => current.map((item) => item.userId === inspector.userId ? { ...item, boxScope: event.target.value } : item))} /> : null}</div>; })}</div></Surface>
      <div className="process-worker-actions"><Button disabled={busy || !saveReady} onClick={() => void save()}>{busy ? "处理中…" : "保存工序&工人"}</Button><Button variant="primary" disabled={busy || !submitReady} onClick={() => void submit()}>{busy ? "提交中…" : "提交 IE 核价"}</Button>{readinessIssues.length ? <p role="status">还需完成：{readinessIssues.join("；")}</p> : <p role="status">{message}</p>}</div>
      {temporaryDialogOpen ? <div className="process-worker-dialog" role="presentation" onMouseDown={() => setTemporaryDialogOpen(false)}><div role="dialog" aria-modal="true" aria-label="新增临时工" onMouseDown={(event) => event.stopPropagation()}><Surface><h2>新增临时工</h2><InsetField label="姓名" value={temporaryName} disabled={busy} onChange={(event) => setTemporaryName(event.target.value)} /><InsetField label="备注（可选）" value={temporaryRemark} disabled={busy} onChange={(event) => setTemporaryRemark(event.target.value)} /><div className="mobile-actions"><Button disabled={busy} onClick={() => setTemporaryDialogOpen(false)}>返回</Button><Button variant="primary" disabled={busy || !temporaryName.trim()} onClick={() => void createTemporaryWorker()}>添加临时工</Button></div></Surface></div></div> : null}
    </div>;
  }
  if (response.reworkStatus === "pending_ie_review") {
    return <div className="process-worker-page"><div className="mobile-hero"><div className="mobile-title"><h1>IE 核价</h1><StatusBadge tone="warning">N03</StatusBadge></div><p>人员已经由尾部主管预分配；IE 只核准工序与单价，不修改分工。</p></div><Surface><h2>工序、单价与预分配人员</h2><PlanReadonly plan={plan} configuration={configuration} /></Surface>{canReview && reviewBlocked ? <Surface><StatusBadge tone="warning">需其他 IE 审核</StatusBadge><p>当前账号参与了本单发起或工序配置，不能自审。</p></Surface> : null}{reviewable ? <Surface><h2>IE 核价</h2><InsetField label="审核意见 / 驳回原因" value={reviewReason} disabled={busy} onChange={(event) => setReviewReason(event.target.value)} placeholder="通过时可选；驳回时必填" /><div className="mobile-actions"><Button disabled={busy || !reviewReason.trim()} onClick={() => void review("rejected")}>驳回修改</Button><Button variant="primary" disabled={busy} onClick={() => void review("approved")}>核价通过</Button></div></Surface> : null}{message ? <p className="process-worker-feedback" role="status">{message}</p> : null}</div>;
  }
  return <Surface className="process-worker-readonly"><StatusBadge tone="success">工序与人员已锁定</StatusBadge><h2>分配工序&工人</h2><PlanReadonly plan={plan} configuration={configuration} />{message ? <p role="status">{message}</p> : null}</Surface>;
}

function PlanReadonly({ plan, configuration }: { plan: ProcessWorkerPlanResponse; configuration?: ProcessConfigurationResponse["configuration"] }) {
  return <div className="process-worker-summary">{plan.assignments.map((assignment) => { const item = configuration?.items.find((candidate) => candidate.configurationItemId === assignment.configurationItemId); return <div key={assignment.configurationItemId}><div><b>{assignment.processName}</b>{item?.unitPrice ? <small>¥{formatPrice(item.unitPrice)} / 件</small> : null}</div><span>{assignment.members.length ? assignment.members.map((member) => `${member.displayName}${member.personType === "temporary" ? "（临时）" : ""}`).join("、") : "未分配人员"}</span></div>; })}</div>;
}
