import { moduleCanWrite } from "./member-module-policy.js";
import {
  ProcessConfigurationOptionsResponseSchema,
  ProcessConfigurationResponseSchema,
  type ProcessConfigurationOptionsResponse,
  type ProcessConfigurationResponse,
  type WorkTaskAssignablePeopleResponse,
} from "@dx-rework/contracts";
import { formatBusinessCurrency, formatBusinessDecimal } from "@dx-rework/contracts/business-display";
import {
  ProcessWorkerPlanActivationResponseSchema,
  ProcessWorkerPlanResponseSchema,
  type ProcessWorkerPlanResponse,
} from "@dx-rework/contracts/process-worker-plan";
import { Button, InsetField, StatusBadge, Surface } from "@dx-rework/ui";
import { useEffect, useMemo, useRef, useState } from "react";

import { createWebUrls } from "../url-contract.js";
import { createClientRequestId } from "./client-request-id.js";
import { verifySession } from "./auth.js";
import { LegacyProcessConfigurationForm } from "./legacy-process-configuration-form.js";
import { SearchSelect } from "./search-select.js";
import { alertInApp, confirmInApp } from "./system-dialog.js";
import { parseWorkTaskOptions } from "./work-task-options.js";
import { WorkReportingForm } from "./work-reporting-form.js";
import "./process-worker-assignment-form.css";
import "./process-worker-assignment-mobile-sheet.css";

const { apiUrl } = createWebUrls(import.meta.env.BASE_URL);

type User = Readonly<{ id: string; businessRoles?: readonly string[]; capabilities: readonly string[]; isRoot?: boolean; readOnlyModules?: readonly ("rework" | "sourcing")[] }>;
export type ProcessWorkerAssignmentDetail = Readonly<{
  reworkOrderId: string;
  createdBy: { userId: string; displayName: string };
  processConfigurationCreatedBy: { userId: string; displayName: string } | null;
}>;
type Person = WorkTaskAssignablePeopleResponse["people"][number];
type PersonIdentity = Pick<Person, "personId" | "displayName" | "personType">;
type ItemForm = Readonly<{ source: "catalog" | "custom"; processId: string; customProcessName: string; unitPrice: string; defaultCandidateCount: number }>;
type PendingSubmit = Readonly<{
  reworkOrderId: string;
  body: { expectedOrderVersion: number; expectedConfigurationVersion: number };
  key: string;
}>;
type MobileAssignmentDraft =
  | Readonly<{ kind: "worker"; index: number; selectedIds: readonly string[] }>
  | Readonly<{ kind: "tail"; selectedIds: readonly string[] }>;

const emptyItem = (): ItemForm => ({ source: "catalog", processId: "", customProcessName: "", unitPrice: "", defaultCandidateCount: 0 });
const formatPrice = (value: number | null): string => value === null ? "" : value.toFixed(3).replace(/\.?0+$/, "");
const toItem = (item: NonNullable<ProcessConfigurationResponse["configuration"]>["items"][number]): ItemForm => ({
  source: item.source,
  processId: item.processId ?? "",
  customProcessName: item.source === "custom" ? item.processName : "",
  unitPrice: formatPrice(item.unitPrice),
  defaultCandidateCount: 0,
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

export function ProcessWorkerAssignmentForm({ reworkOrderId, initialDetail, onOrderChanged, embedded = false, workspaceNode = "process_configuration" }: {
  reworkOrderId: string;
  initialDetail?: ProcessWorkerAssignmentDetail;
  onOrderChanged?: () => Promise<void> | void;
  embedded?: boolean;
  workspaceNode?: "process_configuration" | "ie_review";
}) {
  const [user, setUser] = useState<User | null>(null);
  const [detail, setDetail] = useState<ProcessWorkerAssignmentDetail | null>(initialDetail ?? null);
  const [response, setResponse] = useState<ProcessConfigurationResponse | null>(null);
  const [plan, setPlan] = useState<ProcessWorkerPlanResponse | null>(null);
  const [processOptions, setProcessOptions] = useState<ProcessConfigurationOptionsResponse["processes"]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [items, setItems] = useState<ItemForm[]>([emptyItem()]);
  const [workerIds, setWorkerIds] = useState<Record<string, string[]>>({});
  const [tailPersonIds, setTailPersonIds] = useState<string[]>([]);
  const [tailUnitPrice, setTailUnitPrice] = useState("");
  const [mobileAssignment, setMobileAssignment] = useState<MobileAssignmentDraft | null>(null);
  const [mobileAssignmentSearch, setMobileAssignmentSearch] = useState("");
  const [defaultRosterDirty, setDefaultRosterDirty] = useState<Record<string, boolean>>({});
  const [savingDefaultIndex, setSavingDefaultIndex] = useState<number | null>(null);
  const [tailDefaultRosterDirty, setTailDefaultRosterDirty] = useState(false);
  const [tailDefaultCandidateCount, setTailDefaultCandidateCount] = useState(0);
  const [savingTailDefault, setSavingTailDefault] = useState(false);
  const [assignmentOptionsLoading, setAssignmentOptionsLoading] = useState(true);
  const [reviewReason, setReviewReason] = useState("");
  const [message, setMessage] = useState("正在加载分配工序与工人…");
  const [optionLoadIssue, setOptionLoadIssue] = useState("");
  const [busy, setBusy] = useState(false);
  const [temporaryDialogOpen, setTemporaryDialogOpen] = useState(false);
  const [temporaryEditingPersonId, setTemporaryEditingPersonId] = useState<string | null>(null);
  const [temporaryName, setTemporaryName] = useState("");
  const [temporaryRemark, setTemporaryRemark] = useState("");
  const [temporaryPhoneNumber, setTemporaryPhoneNumber] = useState("");
  const [temporaryIdentityNumber, setTemporaryIdentityNumber] = useState("");
  const pendingKeys = useRef<Record<string, string>>({});
  const pendingSubmit = useRef<PendingSubmit | null>(null);

  const canConfigure = user?.isRoot === true || moduleCanWrite(user, "rework") && Boolean(
    user?.businessRoles?.includes("tail_supervisor")
    && user.capabilities.includes("process:configure")
    && user.capabilities.includes("work:assign"),
  );
  const canReview = user?.isRoot === true || moduleCanWrite(user, "rework") && Boolean(user?.businessRoles?.includes("ie_reviewer") && user.capabilities.includes("process:review"));
  const canCreateTemporary = moduleCanWrite(user, "rework") && (user?.isRoot === true || user?.capabilities.includes("temporary_worker:manage") === true);
  const configuration = response?.configuration ?? null;
  const tailInspectionRequired = response?.tailInspectionRequired ?? true;
  const editable = Boolean(canConfigure && response?.reworkStatus === "pending_process_configuration");
  const reviewBlocked = Boolean(user && user.isRoot !== true && detail && (user.id === detail.createdBy.userId || user.id === detail.processConfigurationCreatedBy?.userId));
  const reviewable = Boolean(canReview && response?.reworkStatus === "pending_ie_review" && !reviewBlocked);
  const itemIssue = validateItems(items);
  const workerIssue = items.findIndex((_, index) => (workerIds[String(index)] ?? []).length === 0);
  const tailPriceIssue = !tailUnitPrice.trim()
    ? "请填写整查候选单价"
    : !threeDecimals.test(tailUnitPrice.trim()) || Number(tailUnitPrice) < 0.001
      ? "整查单价最低 0.001 元，最多三位小数"
      : null;
  const readinessIssues = assignmentOptionsLoading && editable ? [] : [
    ...(itemIssue ? [itemIssue] : []),
    ...(workerIssue >= 0 ? [`工序 ${workerIssue + 1} 至少分配 1 名工人`] : []),
    ...(tailInspectionRequired && tailPriceIssue ? [tailPriceIssue] : []),
    ...(tailInspectionRequired && tailPersonIds.length === 0 ? ["至少分配 1 名整查"] : []),
  ];
  const saveReady = editable && !assignmentOptionsLoading && itemIssue === null && workerIssue < 0
    && (!tailInspectionRequired || (tailPriceIssue === null && tailPersonIds.length > 0));
  const submitReady = saveReady;
  const configurationIssue = !editable
    ? "当前节点不能修改工序与人员。"
    : assignmentOptionsLoading
      ? "工序与人员选项仍在加载，请稍后再试。"
      : readinessIssues.length > 0
        ? `还需完成：${readinessIssues.join("；")}。`
        : null;

  const mutationKey = (signature: string): string => {
    const existing = pendingKeys.current[signature]; if (existing) return existing;
    const next = createClientRequestId(); pendingKeys.current[signature] = next; return next;
  };
  const hydrate = (config: ProcessConfigurationResponse, workerPlan: ProcessWorkerPlanResponse) => {
    setResponse(config); setPlan(workerPlan);
    if (config.configuration) {
      const unified = config.configuration.unifiedExecutionRequired;
      const workerItems = unified
        ? config.configuration.items.filter((item) => item.executionKind !== "tail_inspection")
        : config.configuration.items;
      const tailItem = unified
        ? config.configuration.items.find((item) => item.executionKind === "tail_inspection")
        : undefined;
      setItems(workerItems.map(toItem));
      setTailUnitPrice(unified ? formatPrice(tailItem?.unitPrice ?? null) : "");
      const nextWorkers: Record<string, string[]> = {};
      workerItems.forEach((item, index) => {
        nextWorkers[String(index)] = workerPlan.assignments.find((assignment) => assignment.configurationItemId === item.configurationItemId)?.members.map((member) => member.personId) ?? [];
      });
      setWorkerIds(nextWorkers);
      setDefaultRosterDirty({});
      setTailDefaultRosterDirty(false);
      setTailPersonIds(unified && tailItem
        ? workerPlan.assignments.find((assignment) => assignment.configurationItemId === tailItem.configurationItemId)?.members.map((member) => member.personId) ?? []
        : []);
    }
  };

  const loadCore = async () => {
    setAssignmentOptionsLoading(true);
    const [session, config, workerPlan, loadedDetail] = await Promise.all([
      verifySession(),
      request(`rework-orders/${reworkOrderId}/process-configuration`, ProcessConfigurationResponseSchema.parse),
      request(`rework-orders/${reworkOrderId}/process-worker-plan`, ProcessWorkerPlanResponseSchema.parse),
      initialDetail?.reworkOrderId === reworkOrderId
        ? Promise.resolve(initialDetail)
        : request(`rework-orders/${reworkOrderId}/business-detail`, (value) => value as ProcessWorkerAssignmentDetail),
    ]);
    if (session === "denied" || session.status !== "authorized") throw new Error("当前登录状态已失效，请重新登录。");
    setUser(session.user); setDetail(loadedDetail); hydrate(config, workerPlan);
    const configurable = session.user.isRoot === true || moduleCanWrite(session.user, "rework") && Boolean(session.user.businessRoles?.includes("tail_supervisor") && session.user.capabilities.includes("process:configure") && session.user.capabilities.includes("work:assign"));
    if (configurable && config.reworkStatus === "pending_process_configuration") {
      const [processResult, peopleResult] = await Promise.allSettled([
        request("rework-process-configurations/options", ProcessConfigurationOptionsResponseSchema.parse),
        request("work-task-options", parseWorkTaskOptions),
      ]);
      const issues: string[] = [];
      if (processResult.status === "fulfilled") setProcessOptions(processResult.value.processes);
      else issues.push(`工序目录加载失败：${processResult.reason instanceof Error ? processResult.reason.message : "请刷新重试"}`);
      if (peopleResult.status === "fulfilled") {
        setPeople(peopleResult.value.response.people);
        if (peopleResult.value.compatibilityMode) {
          issues.push("当前 API 仍是上一版本：人员目录需完成后端版本切换后加载");
        } else if (peopleResult.value.response.people.length === 0) {
          issues.push("没有读取到可分配人员，请检查员工权限中的工人角色");
        }
      } else {
        issues.push(`人员加载失败：${peopleResult.reason instanceof Error ? peopleResult.reason.message : "请刷新重试"}`);
      }
      if (processResult.status === "fulfilled" && peopleResult.status === "fulfilled") {
        const eligibleTailIds = new Set(peopleResult.value.response.people
          .filter((person) => person.eligibleExecutionKinds.includes("tail_inspection"))
          .map((person) => person.personId));
        const eligibleDefaults = (processResult.value.tailDefaultWorkerPersonIds ?? []).filter((personId) => eligibleTailIds.has(personId));
        setTailDefaultCandidateCount(config.tailInspectionRequired && !config.configuration ? eligibleDefaults.length : 0);
        if (config.tailInspectionRequired && !config.configuration) setTailPersonIds(eligibleDefaults);
        setTailDefaultRosterDirty(false);
      }
      setOptionLoadIssue(issues.join("；"));
    }
    setAssignmentOptionsLoading(false);
    setMessage("");
  };
  useEffect(() => { void loadCore().catch((error: unknown) => { setAssignmentOptionsLoading(false); setMessage(error instanceof Error ? error.message : "当前节点加载失败"); }); }, [reworkOrderId]);

  const setItem = (index: number, next: Partial<ItemForm>) => { setItems((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, ...next } : item)); pendingSubmit.current = null; };
  const selectCatalogProcess = (index: number, processId: string): void => {
    const defaults = processOptions.find((process) => process.processId === processId)?.defaultWorkerPersonIds ?? [];
    const eligibleIds = new Set(people.filter((person) => person.eligibleExecutionKinds.includes("worker")).map((person) => person.personId));
    const eligibleDefaults = defaults.filter((personId) => eligibleIds.has(personId));
    setItem(index, { processId, defaultCandidateCount: eligibleDefaults.length });
    setWorkerIds((current) => ({ ...current, [String(index)]: eligibleDefaults }));
    setDefaultRosterDirty((current) => ({ ...current, [String(index)]: false }));
  };
  const markDefaultRosterDirty = (index: number): void => {
    if (items[index]?.source !== "catalog" || !items[index]?.processId) return;
    setDefaultRosterDirty((current) => ({ ...current, [String(index)]: true }));
  };
  const removeWorker = (index: number, personId: string) => { setWorkerIds((current) => ({ ...current, [String(index)]: (current[String(index)] ?? []).filter((id) => id !== personId) })); markDefaultRosterDirty(index); pendingSubmit.current = null; };
  const removeTailWorker = (personId: string) => {
    setTailPersonIds((current) => current.filter((id) => id !== personId));
    setTailDefaultRosterDirty(true);
    pendingSubmit.current = null;
  };
  const openMobileWorkerAssignment = (index: number) => {
    setMobileAssignment({ kind: "worker", index, selectedIds: [...(workerIds[String(index)] ?? [])] });
    setMobileAssignmentSearch("");
  };
  const openMobileTailAssignment = () => {
    setMobileAssignment({ kind: "tail", selectedIds: [...tailPersonIds] });
    setMobileAssignmentSearch("");
  };
  const toggleMobileAssignmentPerson = (personId: string) => {
    setMobileAssignment((current) => {
      if (!current) return current;
      const selectedIds = current.selectedIds.includes(personId)
        ? current.selectedIds.filter((id) => id !== personId)
        : [...current.selectedIds, personId];
      return current.kind === "worker"
        ? { kind: "worker", index: current.index, selectedIds }
        : { kind: "tail", selectedIds };
    });
  };
  const cancelMobileAssignment = () => {
    setMobileAssignment(null);
    setMobileAssignmentSearch("");
  };
  const confirmMobileAssignment = () => {
    if (!mobileAssignment) return;
    const selectedIds = [...mobileAssignment.selectedIds];
    if (mobileAssignment.kind === "worker") {
      const key = String(mobileAssignment.index);
      setWorkerIds((current) => ({ ...current, [key]: selectedIds }));
      markDefaultRosterDirty(mobileAssignment.index);
    } else {
      setTailPersonIds(selectedIds);
      setTailDefaultRosterDirty(true);
    }
    pendingSubmit.current = null;
    setMobileAssignment(null);
    setMobileAssignmentSearch("");
  };

  const saveDefaultWorkers = async (index: number): Promise<void> => {
    const item = items[index];
    const personIds = workerIds[String(index)] ?? [];
    if (!item || item.source !== "catalog" || !item.processId || !defaultRosterDirty[String(index)] || personIds.length === 0 || busy) return;
    setBusy(true);
    setSavingDefaultIndex(index);
    try {
      const saved = await request(
        `master-data/processes/${item.processId}/default-workers`,
        (value) => value as { processId: string; rosterVersion: number; personIds: string[] },
        { method: "PUT", body: JSON.stringify({ personIds, changeReason: "尾部主管在工序分配区维护默认工人" }) },
      );
      setProcessOptions((current) => current.map((process) => process.processId === saved.processId
        ? { ...process, defaultWorkerPersonIds: saved.personIds }
        : process));
      setItem(index, { defaultCandidateCount: saved.personIds.length });
      setDefaultRosterDirty((current) => ({ ...current, [String(index)]: false }));
      setMessage("默认工人已保存；以后选择该公共工序时会自动带入这份名单。");
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : "默认工人保存失败");
    } finally {
      setSavingDefaultIndex(null);
      setBusy(false);
    }
  };

  const saveTailDefaultWorkers = async (): Promise<void> => {
    if (!tailDefaultRosterDirty || tailPersonIds.length === 0 || busy) return;
    setBusy(true);
    setSavingTailDefault(true);
    try {
      const saved = await request(
        "master-data/tail-inspection/default-workers",
        (value) => value as { executionKind: "tail_inspection"; rosterVersion: number; personIds: string[] },
        { method: "PUT", body: JSON.stringify({ personIds: tailPersonIds, changeReason: "尾部主管在工序分配区维护整查默认工人" }) },
      );
      setTailPersonIds(saved.personIds);
      setTailDefaultCandidateCount(saved.personIds.length);
      setTailDefaultRosterDirty(false);
      setMessage("整查默认工人已保存；以后新建返工单时会自动带入这份名单。");
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : "整查默认工人保存失败");
    } finally {
      setSavingTailDefault(false);
      setBusy(false);
    }
  };

  const persistMergedDraft = async (): Promise<ProcessConfigurationResponse> => {
    if (!response || !editable || itemIssue || workerIssue >= 0) {
      throw new Error("请先补完整返工工序和人员分配");
    }
    if (tailInspectionRequired && (tailPriceIssue || tailPersonIds.length === 0)) {
      throw new Error("请先补完整整查计件信息");
    }
    const configItems = items.map((item) => ({
      source: item.source,
      ...(item.source === "catalog" ? { processId: item.processId } : { customProcessName: item.customProcessName.trim() }),
      executionKind: "worker" as const, plannedQuantity: 1, pricingUnit: "piece" as const, unitPrice: Number(item.unitPrice),
    }));
    const configBody = {
      expectedOrderVersion: response.orderVersion,
      items: tailInspectionRequired
        ? [...configItems, { source: "custom" as const, customProcessName: "整查", executionKind: "tail_inspection" as const, plannedQuantity: 1, pricingUnit: "piece" as const, unitPrice: Number(tailUnitPrice) }]
        : configItems,
    };
    const configSignature = `config:${JSON.stringify(configBody)}`;
    const saved = await request(`rework-orders/${reworkOrderId}/process-configuration/draft`, ProcessConfigurationResponseSchema.parse, { method: "PUT", headers: { "idempotency-key": mutationKey(configSignature) }, body: JSON.stringify(configBody) });
    delete pendingKeys.current[configSignature];
    const savedConfiguration = saved.configuration;
    if (!savedConfiguration || savedConfiguration.status !== "draft") throw new Error("工序保存后的版本异常，请刷新后重试");
    const savedWorkerItems = savedConfiguration.items.filter((item) => item.executionKind !== "tail_inspection");
    const savedTailItem = savedConfiguration.items.find((item) => item.executionKind === "tail_inspection");
    if (savedWorkerItems.length !== items.length || (tailInspectionRequired && !savedTailItem)) {
      throw new Error("执行工序保存不完整，请刷新后重试");
    }
    const planBody = {
      expectedOrderVersion: saved.orderVersion,
      configurationId: savedConfiguration.configurationId,
      expectedConfigurationVersion: savedConfiguration.configurationVersion,
      assignments: [
        ...savedWorkerItems.map((item, index) => ({ configurationItemId: item.configurationItemId, memberIds: workerIds[String(index)] ?? [] })),
        ...(tailInspectionRequired && savedTailItem
          ? [{ configurationItemId: savedTailItem.configurationItemId, memberIds: tailPersonIds }]
          : []),
      ],
    };
    const planSignature = `plan:${JSON.stringify(planBody)}`;
    const savedPlan = await request(`rework-orders/${reworkOrderId}/process-worker-plan`, ProcessWorkerPlanResponseSchema.parse, { method: "PUT", headers: { "idempotency-key": mutationKey(planSignature) }, body: JSON.stringify(planBody) });
    delete pendingKeys.current[planSignature]; hydrate(saved, savedPlan); return saved;
  };

  const save = async () => {
    if (busy) return;
    if (!saveReady) {
      const issue = configurationIssue ?? "当前工序与人员资料暂不能保存。";
      setMessage(issue);
      await alertInApp(issue, { title: "工序与人员暂不能保存", confirmLabel: "知道了" });
      return;
    }
    setBusy(true); try { await persistMergedDraft(); setMessage("工序与工人已保存；人员会在 IE 核价通过后自动生效。"); }
    catch (error: unknown) { setMessage(error instanceof Error ? error.message : "工序与工人保存失败"); } finally { setBusy(false); }
  };
  const submit = async () => {
    if (busy) return;
    if (!submitReady) {
      const issue = configurationIssue ?? "当前工序与人员资料暂不能提交。";
      setMessage(issue);
      await alertInApp(issue, { title: "工序与人员暂不能提交", confirmLabel: "知道了" });
      return;
    }
    if (!(await confirmInApp("确认提交当前工序、候选单价和预分配工人给 IE 核价？"))) return;
    setBusy(true);
    try {
      let attempt = pendingSubmit.current;
      if (!attempt) {
        const saved = await persistMergedDraft(); const savedConfiguration = saved.configuration; if (!savedConfiguration) throw new Error("工序配置不存在");
        attempt = { reworkOrderId, body: { expectedOrderVersion: saved.orderVersion, expectedConfigurationVersion: savedConfiguration.configurationVersion }, key: createClientRequestId() };
        pendingSubmit.current = attempt;
      }
      const submitted = await request(`rework-orders/${reworkOrderId}/process-configuration/submit`, ProcessConfigurationResponseSchema.parse, { method: "POST", headers: { "idempotency-key": attempt.key }, body: JSON.stringify(attempt.body) });
      pendingSubmit.current = null; setResponse(submitted); setMessage(tailInspectionRequired ? "已提交 IE 核价；返工人员与整查方案已锁定，IE 通过后统一开始执行。" : "已提交 IE 核价；返工人员方案已锁定，IE 通过后开始执行。"); await onOrderChanged?.();
    } catch (error: unknown) {
      const failure = error instanceof Error ? error.message : "提交 IE 核价失败";
      setMessage(failure);
      await alertInApp(failure, { title: "工序配置提交失败", confirmLabel: "知道了" });
    } finally { setBusy(false); }
  };
  const review = async (decision: "approved" | "rejected") => {
    if (!response || !configuration || !reviewable || busy) return;
    if (decision === "rejected" && !reviewReason.trim()) {
      const issue = "IE 驳回必须填写原因。";
      setMessage(issue);
      await alertInApp(issue, { title: "核价暂不能驳回", confirmLabel: "知道了" });
      return;
    }
    if (!(await confirmInApp(decision === "approved" ? (tailInspectionRequired ? "确认核价通过？通过后返工人员与整查任务会统一生效并开始执行。" : "确认核价通过？通过后返工任务会生效并开始执行。") : "确认驳回并退回尾部主管修改？"))) return;
    setBusy(true);
    try {
      const reviewBody = { expectedOrderVersion: response.orderVersion, expectedConfigurationVersion: configuration.configurationVersion, decision, reason: reviewReason.trim() || undefined };
      const reviewSignature = `review:${JSON.stringify(reviewBody)}`;
      const reviewed = await request(`rework-orders/${reworkOrderId}/process-configuration/review`, ProcessConfigurationResponseSchema.parse, { method: "POST", headers: { "idempotency-key": mutationKey(reviewSignature) }, body: JSON.stringify(reviewBody) });
      delete pendingKeys.current[reviewSignature];
      const latestPlan = await request(`rework-orders/${reworkOrderId}/process-worker-plan`, ProcessWorkerPlanResponseSchema.parse); hydrate(reviewed, latestPlan);
      setMessage(decision === "approved" ? reviewed.reworkStatus === "in_progress" ? (tailInspectionRequired ? "IE 已通过；返工人员与整查任务已统一生效，返工开始。" : "IE 已通过；返工任务已生效，返工开始。") : "IE 已通过；自动启动未完成，尾部主管可在本节点重试启动。" : "IE 已驳回，等待尾部主管重新配置工序与工人。");
      await onOrderChanged?.();
    } catch (error: unknown) { setMessage(error instanceof Error ? error.message : "IE 核价提交失败"); } finally { setBusy(false); }
  };
  const recoverActivation = async () => {
    if (!response || !plan?.configurationVersion || busy) return;
    setBusy(true);
    try {
      await request(`rework-orders/${reworkOrderId}/process-worker-plan/activate`, ProcessWorkerPlanActivationResponseSchema.parse, { method: "POST", headers: { "idempotency-key": createClientRequestId() }, body: JSON.stringify({ expectedOrderVersion: response.orderVersion, expectedConfigurationVersion: plan.configurationVersion }) });
      setMessage(tailInspectionRequired ? "返工人员与整查任务已生效，返工开始。" : "返工任务已生效，返工开始。"); await onOrderChanged?.();
    } catch (error: unknown) { setMessage(error instanceof Error ? error.message : "返工启动失败"); } finally { setBusy(false); }
  };
  const reloadPeople = async () => {
    const workers = await request("work-task-options", parseWorkTaskOptions);
    setPeople(workers.response.people);
    setOptionLoadIssue(workers.compatibilityMode
      ? "当前 API 仍是上一版本：人员目录需完成后端版本切换后加载"
      : "");
  };
  const closeTemporaryWorkerDialog = () => {
    if (busy) return;
    setTemporaryDialogOpen(false);
    setTemporaryEditingPersonId(null);
    setTemporaryName("");
    setTemporaryRemark("");
    setTemporaryPhoneNumber("");
    setTemporaryIdentityNumber("");
  };
  const openTemporaryWorkerCreate = () => {
    if (!canCreateTemporary || busy) return;
    setTemporaryEditingPersonId(null);
    setTemporaryName("");
    setTemporaryRemark("");
    setTemporaryPhoneNumber("");
    setTemporaryIdentityNumber("");
    setTemporaryDialogOpen(true);
  };
  const openTemporaryWorkerProfile = async (personId: string) => {
    if (!canCreateTemporary || busy) return;
    setBusy(true);
    try {
      const profile = await request(`master-data/temporary-workers/${personId}`, (value) => value as {
        personId: string;
        displayName: string;
        temporaryRemark: string | null;
        temporaryPhoneNumber: string | null;
        temporaryIdentityNumber: string | null;
      });
      setTemporaryEditingPersonId(profile.personId);
      setTemporaryName(profile.displayName);
      setTemporaryRemark(profile.temporaryRemark ?? "");
      setTemporaryPhoneNumber(profile.temporaryPhoneNumber ?? "");
      setTemporaryIdentityNumber(profile.temporaryIdentityNumber ?? "");
      setTemporaryDialogOpen(true);
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : "临时工资料加载失败");
    } finally {
      setBusy(false);
    }
  };
  const saveTemporaryWorker = async () => {
    const name = temporaryName.trim(); const remark = temporaryRemark.trim();
    const phoneNumber = temporaryPhoneNumber.trim().replace(/[\s-]/g, "");
    const identityNumber = temporaryIdentityNumber.trim().toUpperCase();
    if (!canCreateTemporary || busy || !name) return;
    setBusy(true);
    try {
      if (temporaryEditingPersonId) {
        await request(`master-data/temporary-workers/${temporaryEditingPersonId}`, (value) => value as { personId: string }, {
          method: "PUT",
          body: JSON.stringify({
            temporaryRemark: remark || null,
            temporaryPhoneNumber: phoneNumber || null,
            temporaryIdentityNumber: identityNumber || null,
            reason: "N02 分配工序&工人补录临时工资料",
          }),
        });
        setTemporaryDialogOpen(false);
        setTemporaryEditingPersonId(null);
        setTemporaryName("");
        setTemporaryRemark("");
        setTemporaryPhoneNumber("");
        setTemporaryIdentityNumber("");
        setMessage(`临时工 ${name} 的资料已保存。`);
        return;
      }
      await request("master-data/temporary-workers", (value) => value as { personId: string }, { method: "POST", body: JSON.stringify({ personType: "temporary", displayName: name, aliases: [], reason: "N02 分配工序&工人现场新增临时工", ...(remark ? { temporaryRemark: remark } : {}), ...(phoneNumber ? { temporaryPhoneNumber: phoneNumber } : {}), ...(identityNumber ? { temporaryIdentityNumber: identityNumber } : {}) }) });
      await reloadPeople(); setTemporaryName(""); setTemporaryRemark(""); setTemporaryPhoneNumber(""); setTemporaryIdentityNumber(""); setTemporaryDialogOpen(false); setMessage(`临时工 ${name} 已添加，可直接分配。`);
    } catch (error: unknown) { setMessage(error instanceof Error ? error.message : temporaryEditingPersonId ? "临时工资料保存失败" : "临时工添加失败"); } finally { setBusy(false); }
  };

  const workerOptions = useMemo(() => people.filter((person) => person.eligibleExecutionKinds.includes("worker")), [people]);
  const tailOptions = useMemo(() => people.filter((person) => person.eligibleExecutionKinds.includes("tail_inspection")), [people]);
  const peopleById = useMemo(() => {
    const identities = new Map<string, PersonIdentity>();
    for (const assignment of plan?.assignments ?? []) {
      for (const member of assignment.members) identities.set(member.personId, member);
    }
    for (const person of people) identities.set(person.personId, person);
    return identities;
  }, [people, plan]);
  const mobileAssignmentOptions = mobileAssignment?.kind === "tail" ? tailOptions : workerOptions;
  const mobileAssignmentNeedle = mobileAssignmentSearch.trim().toLocaleLowerCase();
  const mobileFilteredOptions = mobileAssignmentOptions.filter((person) => {
    const personType = person.personType === "temporary" ? "临时工" : "正式工";
    return !mobileAssignmentNeedle || `${person.displayName} ${personType}`.toLocaleLowerCase().includes(mobileAssignmentNeedle);
  });
  const mobileAssignmentGroups = [
    { label: "正式工", people: mobileFilteredOptions.filter((person) => person.personType === "internal") },
    { label: "临时工", people: mobileFilteredOptions.filter((person) => person.personType === "temporary") },
  ];
  const changedProps = onOrderChanged ? { onOrderChanged } : {};

  if (!response || !plan) return <Surface>{message || "正在加载…"}</Surface>;
  if (workspaceNode === "ie_review" && !["pending_process_configuration", "pending_ie_review"].includes(response.reworkStatus)) {
    return <Surface className="process-worker-readonly process-worker-ie-review-readonly">
      <StatusBadge tone="success">IE 核价已完成</StatusBadge>
      <h2>IE 核价</h2>
      <PlanReadonly plan={plan} configuration={configuration} />
      <p>以下为 IE 已核准并锁定的工序单价与执行人员快照。</p>
    </Surface>;
  }
  if (configuration && plan.required === false) {
    if (response.reworkStatus === "pending_task_assignment") return <WorkReportingForm reworkOrderId={reworkOrderId} taskMode="task_assignment" embedded={embedded} {...changedProps} />;
    return <LegacyProcessConfigurationForm reworkOrderId={reworkOrderId} embedded={embedded} {...changedProps} />;
  }
  if (response.reworkStatus === "pending_task_assignment") {
    return <Surface className="process-worker-recovery"><StatusBadge tone="warning">IE 已通过</StatusBadge><h2>预分配人员等待启动</h2><p>正常情况下 IE 通过后会自动开始返工；本单未自动启动，可由尾部主管重试，不需要重新选人。</p><PlanReadonly plan={plan} />{canConfigure ? <Button variant="primary" disabled={busy} onClick={() => void recoverActivation()}>{busy ? "启动中…" : "重试开始返工"}</Button> : null}{message ? <p role="status">{message}</p> : null}</Surface>;
  }
  if (editable) {
    return <div className={`process-worker-page${embedded ? " is-embedded" : ""}`}>
      {!embedded && <div className="mobile-hero"><div className="mobile-title"><h1>分配工序 &工人</h1><StatusBadge tone="info">N02</StatusBadge></div><p>{tailInspectionRequired ? "返工工序与整查一次分配；IE 只核价，通过后全部执行任务统一生效。" : "本单无需整查；只需分配返工工序与人员，IE 核价通过后开始执行。"}</p></div>}
      <Surface>
        <div className="section-title"><div><h2>工序与人员</h2><p>左侧设置工序与价格，右侧快速分配正式工或临时工；每道工序至少 1 人。</p></div><Button disabled={busy} onClick={() => { setItems((current) => [...current, emptyItem()]); setWorkerIds((current) => ({ ...current, [String(items.length)]: [] })); }}>增加工序</Button></div>
        {optionLoadIssue ? <p className="process-worker-option-alert" role="alert">{optionLoadIssue}</p> : null}
        <div className="process-worker-lines">{items.map((item, index) => {
          const key = String(index);
          const selectedIds = workerIds[key] ?? [];
          const rosterDirty = defaultRosterDirty[key] === true;
          const publicProcessSelected = item.source === "catalog" && Boolean(item.processId);
          return <section className="process-worker-line" key={index}>
            <div className="process-worker-line__heading"><b>工序 {index + 1}</b>{items.length > 1 ? <Button disabled={busy} onClick={() => { setItems((current) => current.filter((_, itemIndex) => itemIndex !== index)); setWorkerIds((current) => Object.fromEntries(items.filter((_, itemIndex) => itemIndex !== index).map((_, newIndex) => { const oldIndex = newIndex >= index ? newIndex + 1 : newIndex; return [String(newIndex), current[String(oldIndex)] ?? []]; }))); setDefaultRosterDirty({}); }}>删除</Button> : null}</div>
            <div className="process-worker-line__body">
              <div className="process-worker-fields">
                <div className="process-worker-source"><label><input type="radio" checked={item.source === "catalog"} disabled={busy} onChange={() => setItem(index, { source: "catalog", customProcessName: "" })} /> 公共工序</label><label><input type="radio" checked={item.source === "custom"} disabled={busy} onChange={() => setItem(index, { source: "custom", processId: "", defaultCandidateCount: 0 })} /> 自定义工序</label></div>
                {item.source === "catalog" ? <label className="dx-field"><span>返工工序</span><span className="dx-field__control search-select-control"><SearchSelect options={processOptions.map((process) => ({ value: process.processId, label: process.processName }))} value={item.processId} placeholder="搜索工序" emptyText="没有匹配工序" disabled={busy} onChange={(processId) => selectCatalogProcess(index, processId)} /></span>{item.defaultCandidateCount > 0 ? <small className="process-worker-default-candidates">已自动带入 {item.defaultCandidateCount} 名默认候选人</small> : null}</label> : <InsetField label="自定义工序" value={item.customProcessName} disabled={busy} onChange={(event) => setItem(index, { customProcessName: event.target.value })} />}
                <InsetField label="候选单价（元/件）" type="number" min="0.001" step="0.001" inputMode="decimal" value={item.unitPrice} disabled={busy} onChange={(event) => setItem(index, { unitPrice: event.target.value })} />
              </div>
              <div className="process-worker-picker">
                <div className="process-worker-picker__heading"><b>返工人员 *</b><div className="process-worker-roster-actions"><Button className="process-worker-add-default" variant="primary" disabled={busy || (!item.processId && item.source === "catalog")} onClick={() => openMobileWorkerAssignment(index)}>选择本单工人</Button>{publicProcessSelected ? <Button className="process-worker-save-default" {...(rosterDirty ? { variant: "primary" as const } : {})} disabled={busy || !rosterDirty || selectedIds.length === 0} onClick={() => void saveDefaultWorkers(index)}>{savingDefaultIndex === index ? "保存中…" : "保存为默认名单"}</Button> : null}</div></div>
                <div className="process-worker-default-list" aria-label="已分配人员">{selectedIds.length ? selectedIds.map((personId) => { const person = peopleById.get(personId); const name = person?.displayName ?? "返工人员"; const temporary = person?.personType === "temporary"; return <span key={personId}><button type="button" aria-label={`移除 ${name}`} disabled={busy} onClick={() => removeWorker(index, personId)}>−</button><small>{temporary && canCreateTemporary ? <button type="button" className="process-worker-temporary-name" aria-label={`补录或修改 ${name} 的临时工资料`} disabled={busy} onClick={() => void openTemporaryWorkerProfile(personId)}>{name}</button> : name}{temporary ? " · 临时工" : ""}</small></span>; }) : <small>至少选择 1 名返工人员</small>}</div>
              </div>
            </div>
          </section>;
        })}</div>
      </Surface>
      {tailInspectionRequired ? <Surface className="process-worker-tail-card">
        <div className="section-title"><div><h2>整查工序</h2><p>整查作为特殊计件工序，与返工人员统一分配、统一报数。</p></div><StatusBadge tone={tailPersonIds.length ? "success" : "warning"}>{tailPersonIds.length ? `已分配 ${formatBusinessDecimal(tailPersonIds.length)} 人` : assignmentOptionsLoading ? "加载中" : "至少 1 人"}</StatusBadge></div>
        <div className="process-worker-tail-body">
          <div className="process-worker-tail-work"><div className="process-worker-tail-title-row"><b>整查</b></div><InsetField label="整查候选单价（元/件）" type="number" min="0.001" step="0.001" inputMode="decimal" value={tailUnitPrice} disabled={busy} onChange={(event) => { setTailUnitPrice(event.target.value); pendingSubmit.current = null; }} /></div>
          <div className="process-worker-picker">
            <div className="process-worker-picker__heading"><b>整查人员 *</b><div className="process-worker-roster-actions"><Button className="process-worker-add-default" variant="primary" disabled={busy || assignmentOptionsLoading} onClick={openMobileTailAssignment}>选择本单工人</Button><Button className="process-worker-save-default" {...(tailDefaultRosterDirty ? { variant: "primary" as const } : {})} disabled={busy || assignmentOptionsLoading || !tailDefaultRosterDirty || tailPersonIds.length === 0} onClick={() => void saveTailDefaultWorkers()}>{savingTailDefault ? "保存中…" : "保存为默认名单"}</Button></div></div>
            <div className="process-worker-default-list" aria-label="已分配人员">{tailPersonIds.length ? tailPersonIds.map((personId) => { const person = peopleById.get(personId); const name = person?.displayName ?? "整查人员"; const temporary = person?.personType === "temporary"; return <span key={personId}><button type="button" aria-label={`移除 ${name}`} disabled={busy} onClick={() => removeTailWorker(personId)}>−</button><small>{temporary && canCreateTemporary ? <button type="button" className="process-worker-temporary-name" aria-label={`补录或修改 ${name} 的临时工资料`} disabled={busy} onClick={() => void openTemporaryWorkerProfile(personId)}>{name}</button> : name}{temporary ? " · 临时工" : ""}</small></span>; }) : <small>{assignmentOptionsLoading ? "正在加载默认名单…" : "至少选择 1 名整查人员"}</small>}</div>
            {tailDefaultCandidateCount > 0 ? <small className="process-worker-default-candidates">已自动带入 {formatBusinessDecimal(tailDefaultCandidateCount)} 名默认候选人</small> : null}
          </div>
        </div>
      </Surface> : null}
      <div className="process-worker-actions"><Button data-ready={saveReady ? "true" : "false"} disabled={busy || assignmentOptionsLoading} onClick={() => void save()}>{busy ? "处理中…" : "保存工序&工人"}</Button><Button variant="primary" data-ready={submitReady ? "true" : "false"} disabled={busy || assignmentOptionsLoading} onClick={() => void submit()}>{busy ? "提交中…" : "提交 IE 核价"}</Button>{readinessIssues.length ? <p role="status">还需完成：{readinessIssues.join("；")}</p> : <p role="status">{message}</p>}</div>
      {mobileAssignment ? <div className="process-worker-mobile-sheet-backdrop" role="presentation" onMouseDown={cancelMobileAssignment}><section className="process-worker-mobile-sheet" role="dialog" aria-modal="true" aria-label="选择本单工人" onMouseDown={(event) => event.stopPropagation()}>
        <div className="process-worker-mobile-sheet__heading"><div><h2>选择本单工人</h2><small>已选择 {formatBusinessDecimal(mobileAssignment.selectedIds.length)} 人</small></div></div>
        <input className="process-worker-people-search" type="search" value={mobileAssignmentSearch} placeholder="搜索正式工或临时工" disabled={busy} onChange={(event) => setMobileAssignmentSearch(event.target.value)} />
        <div className="process-worker-mobile-sheet__selected"><small>当前选择</small><span>{mobileAssignment.selectedIds.length ? mobileAssignment.selectedIds.map((personId) => peopleById.get(personId)?.displayName ?? "已选人员").join("、") : "暂未选择"}</span></div>
        <div className="process-worker-mobile-sheet__groups">{mobileAssignmentGroups.map((group) => <fieldset className="process-worker-people-group" key={group.label}><legend><span>{group.label}</span><small>{formatBusinessDecimal(group.people.length)} 人</small>{group.label === "临时工" && canCreateTemporary ? <button type="button" disabled={busy} onClick={openTemporaryWorkerCreate}>＋新增</button> : null}</legend><div>{group.people.length ? group.people.map((person) => <label key={person.personId}><input type="checkbox" checked={mobileAssignment.selectedIds.includes(person.personId)} disabled={busy} onChange={() => toggleMobileAssignmentPerson(person.personId)} /><span>{person.displayName}</span></label>) : <p>{optionLoadIssue ? "人员目录暂不可用" : "没有匹配人员"}</p>}</div></fieldset>)}</div>
        <div className="process-worker-mobile-sheet__actions"><Button disabled={busy} onClick={cancelMobileAssignment}>取消</Button><Button variant="primary" disabled={busy || mobileAssignment.selectedIds.length === 0} onClick={confirmMobileAssignment}>确认本单分工</Button></div>
      </section></div> : null}
      {temporaryDialogOpen ? <div className="process-worker-dialog" role="presentation" onMouseDown={closeTemporaryWorkerDialog}><div role="dialog" aria-modal="true" aria-label={temporaryEditingPersonId ? "补录或修改临时工资料" : "新增临时工"} onMouseDown={(event) => event.stopPropagation()}><Surface><h2>{temporaryEditingPersonId ? "补录或修改临时工资料" : "新增临时工"}</h2><InsetField label="姓名（必填）" value={temporaryName} maxLength={100} disabled={busy || Boolean(temporaryEditingPersonId)} onChange={(event) => setTemporaryName(event.target.value)} /><InsetField label="手机号（选填）" value={temporaryPhoneNumber} maxLength={30} inputMode="tel" disabled={busy} onChange={(event) => setTemporaryPhoneNumber(event.target.value)} /><InsetField label="身份证号（选填）" value={temporaryIdentityNumber} maxLength={18} disabled={busy} onChange={(event) => setTemporaryIdentityNumber(event.target.value)} /><InsetField label="备注（选填）" value={temporaryRemark} maxLength={100} disabled={busy} onChange={(event) => setTemporaryRemark(event.target.value)} /><div className="mobile-actions"><Button disabled={busy} onClick={closeTemporaryWorkerDialog}>返回</Button><Button variant="primary" disabled={busy || !temporaryName.trim()} onClick={() => void saveTemporaryWorker()}>{temporaryEditingPersonId ? "保存资料" : "添加临时工"}</Button></div></Surface></div></div> : null}
    </div>;
  }
  if (response.reworkStatus === "pending_ie_review") {
    return <div className={`process-worker-page${embedded ? " is-embedded" : ""}`}>{!embedded && <div className="mobile-hero"><div className="mobile-title"><h1>IE 核价</h1><StatusBadge tone="warning">N03</StatusBadge></div><p>人员已经由尾部主管预分配；IE 只核准工序与单价，不修改分工。</p></div>}<Surface><h2>工序、单价与预分配人员</h2><PlanReadonly plan={plan} configuration={configuration} /></Surface>{canReview && reviewBlocked ? <Surface><StatusBadge tone="warning">需其他 IE 审核</StatusBadge><p>当前账号参与了本单发起或工序配置，不能自审。</p></Surface> : null}{reviewable ? <Surface><h2>IE 核价</h2><InsetField label="审核意见 / 驳回原因" value={reviewReason} disabled={busy} onChange={(event) => setReviewReason(event.target.value)} placeholder="通过时可选；驳回时必填" /><div className="mobile-actions"><Button data-ready={reviewReason.trim() ? "true" : "false"} disabled={busy} onClick={() => void review("rejected")}>驳回修改</Button><Button variant="primary" disabled={busy} onClick={() => void review("approved")}>核价通过</Button></div></Surface> : null}{message ? <p className="process-worker-feedback" role="status">{message}</p> : null}</div>;
  }
  return <Surface className="process-worker-readonly"><StatusBadge tone="success">工序与人员已锁定</StatusBadge><h2>分配工序 &工人</h2><PlanReadonly plan={plan} configuration={configuration} />{message ? <p role="status">{message}</p> : null}</Surface>;
}

function PlanReadonly({ plan, configuration }: { plan: ProcessWorkerPlanResponse; configuration?: ProcessConfigurationResponse["configuration"] }) {
  return <div className="process-worker-summary">{plan.assignments.map((assignment) => { const item = configuration?.items.find((candidate) => candidate.configurationItemId === assignment.configurationItemId); return <div key={assignment.configurationItemId}><div><b>{assignment.executionKind === "tail_inspection" ? "整查 · 特殊工序" : assignment.processName}</b>{item?.unitPrice ? <small>{formatBusinessCurrency(item.unitPrice)} / 件</small> : null}</div><span>{assignment.members.length ? assignment.members.map((member) => `${member.displayName}${member.personType === "temporary" ? "（临时）" : ""}`).join("、") : "未分配人员"}</span></div>; })}</div>;
}
