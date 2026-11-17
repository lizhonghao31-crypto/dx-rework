import { JOURNEY_NODES,JourneyFilterSchema,JourneyReturnContextSchema, journeyReturnUrl, type JourneyNode, type JourneyRecord, type JourneyState, type OrderJourney } from "@dx-rework/contracts/digital-production-journey";
import {deliveryReturnPath} from './delivery-calendar-model.js';

export type CockpitContext = ReturnType<typeof JourneyReturnContextSchema.parse>;
export const journeyStateLabels: Record<JourneyState, string> = { uncreated: "未启动", pending: "待前置", active: "进行中", blocked: "受阻", completed: "已完成", cancelled: "已取消", not_applicable: "不适用", unavailable: "无可见事实", inherited: "沿用前轮" };
export const journeyRiskLabels = { overdue: "已逾期", due_soon: "即将到期", blocked: "受阻", unknown: "时间待核实" };
export function cockpitContext(search: string): CockpitContext {
  const params = new URLSearchParams(search);
  const input = Object.fromEntries([...params].filter(([key]) => key in JourneyReturnContextSchema.shape && (params.get(key) !== "" || key === "milestone" || key === "expanded" || key === "row")));
  // Retired workspace links remain usable without treating "bulk" as a Journey stage.
  if (input.stage === "bulk") input.stage = "preparation";
  const parsed = JourneyReturnContextSchema.safeParse(input);
  return parsed.success ? parsed.data : JourneyReturnContextSchema.parse({});
}
export const cockpitFilterPatch=(context:CockpitContext)=>Object.fromEntries(Object.entries(context).filter(([key])=>key in JourneyFilterSchema.shape)) as Partial<CockpitContext>;
export function cockpitQuery(context: CockpitContext): string {
  return new URLSearchParams(Object.entries(cockpitFilterPatch(context)).filter(([,value])=>value!==undefined&&value!=='').map(([key,value])=>[key,String(value)])).toString();
}
export function cockpitReturnPath(search: string): string | null {
  const candidate = new URLSearchParams(search).get("returnTo");
  if (!candidate || candidate.includes("\\") || !candidate.startsWith("/ui/digital-cockpit?")) return null;
  const params = new URLSearchParams(candidate.slice(candidate.indexOf("?")));
  if (candidate.includes("#") || [...params.keys()].length !== new Set(params.keys()).size) return null;
  const workspace = params.get("workspace");
  if (workspace !== null && !["preparation", "factory"].includes(workspace)) return null;
  params.delete("workspace");
  const calendarValue=params.get('deliveryReturn'),calendarReturn=deliveryReturnPath(calendarValue);
  if(calendarValue!==null&&!calendarReturn)return null;
  params.delete('deliveryReturn');
  const parsed = JourneyReturnContextSchema.safeParse(Object.fromEntries(params));
  return parsed.success ? journeyReturnUrl(parsed.data) + (workspace ? `&workspace=${workspace}` : "")+(calendarReturn?'&'+new URLSearchParams({deliveryReturn:calendarReturn}):'') : null;
}
export function journeyRecordHref(url: string, context: CockpitContext, mode?: JourneyRecord["mode"]): string {
  if (!url.startsWith("/ui/") || url.includes("\\")) return "";
  const parsed = new URL(url, "https://local.invalid");
  if (mode && parsed.pathname === "/ui/digital-production" && parsed.searchParams.has("task")) parsed.searchParams.set("taskView", mode);
  const calendarReturn=typeof window==='undefined'?null:deliveryReturnPath(new URLSearchParams(window.location.search).get('deliveryReturn'),import.meta.env.BASE_URL);
  parsed.searchParams.set("returnTo", journeyReturnUrl(context)+(calendarReturn?'&'+new URLSearchParams({deliveryReturn:calendarReturn}):''));
  return parsed.pathname + parsed.search + parsed.hash;
}
export function journeyTime(value: string | null, precision: JourneyNode["expectedPrecision"] = "instant", missing = "未登记"): string {
  if (!value) return missing;
  if (precision === "date") return value;
  const at = new Date(value);
  return Number.isFinite(at.getTime()) ? at.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }) : missing;
}
export function lateDuration(seconds: number | null): string {
  if (seconds === null) return "已逾期";
  if (seconds >= 86400) return "逾期 " + Number((seconds / 86400).toFixed(1)) + " 天";
  return "逾期 " + Number((seconds / 3600).toFixed(1)) + " 小时";
}
export function nodeOverdue(node: JourneyNode, asOf?: string): string {
  if(node.fixedTargets?.length){
    const overdue=node.fixedTargets.flatMap(target=>target.progress.ownSla.state==='overdue'&&target.progress.ownSla.overdueMinutes?[target.progress.ownSla.overdueMinutes]:[]);
    if(!overdue.length)return '已逾期';
    const minimum=Math.max(...overdue.map(value=>value.minimum)),maximum=Math.max(...overdue.map(value=>value.maximum));
    return (minimum!==maximum?'至少':'')+lateDuration(minimum*60);
  }
  if (node.expectedPrecision === "date" && node.expectedAt && asOf) {
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(asOf));
    const days = (Date.parse(today) - Date.parse(node.expectedAt)) / 86400000;
    if (days > 0) return "原计划逾期 " + days + " 天";
  }
  return lateDuration(node.overdueSeconds);
}
export function nodeStatus(node: JourneyNode, asOf?: string): string {
  const stopped=nodeTerminationLabel(node);if(stopped)return stopped;
  if (node.state === "completed") {
    if (node.completionResult === "early") return "提前完成";
    if (node.completionResult === "on_time") return "按时完成";
    if (node.completionResult === "late") return lateDuration(node.overdueSeconds);
    return node.actualQuality === "unverified" ? "已完成 · 时间未核实" : "已完成 · 完成时效未知";
  }
  if (node.state === "unavailable") return node.unavailableReason === "permission" ? "无权限查看" : "尚无原事实";
  if (node.state === "inherited") return "沿用第 " + node.inheritedFrom?.round + " 轮";
  return node.risks.includes("overdue") ? journeyStateLabels[node.state] + " · " + nodeOverdue(node, asOf) : journeyStateLabels[node.state];
}
/** Minimum reader support for terminated timing, including legacy DTOs whose
 * only terminal proof is the already scoped fixed progress. No client clock
 * arithmetic or business-state mutation is involved. */
export function nodeTerminationLabel(node:JourneyNode):string|null{
 if(['completed','inherited','not_applicable','unavailable'].includes(node.state))return null;
 const timings=[...(node.timings??[]),...(node.timing?[node.timing]:[])].filter(timing=>timing.termination);
 const fixed=(node.fixedTargets??[]).filter(target=>!target.progress.businessCompleted);
 const fixedStop=fixed.length>0&&fixed.every(target=>target.progress.goalDelta.kind==='terminated');
 if(!timings.length&&!fixedStop)return null;
 const unknown=timings.some(timing=>timing.status==='unknown')||fixedStop&&fixed.some(target=>target.progress.ownSla.state==='unknown');
 return (node.state==='cancelled'?'已取消 · ':'')+(unknown?'已终止 · 责任时间待核':'计时已终止');
}
export function stageTimes(stage: OrderJourney["stages"][number]) {
  if (stage.state === "not_applicable") return { expected: "不适用", actual: "不适用" };
  if (stage.state === "unavailable") return { expected: "无可见时间", actual: "无可见时间" };
  const nodes = stage.nodes.filter(node => node.current && !["not_applicable", "cancelled", "inherited", "unavailable"].includes(node.state));
  // Partial targets cannot imply an agreed target for the whole phase.
  const samePrecision = new Set(nodes.map(node => node.expectedPrecision)).size === 1;
  const latestExpected = nodes.map(node => node.expectedAt ?? "").sort().at(-1) ?? null;
  const latestActual = nodes.map(node => node.actualAt ?? "").sort().at(-1) ?? null;
  const expected = nodes.length && nodes.every(node => node.expectedAt) ? samePrecision ? journeyTime(latestExpected, nodes[0]!.expectedPrecision) : "见各节点目标" : "未完整登记";
  const actual = nodes.length && nodes.every(node => node.state === "completed" && node.actualAt && node.actualQuality === "verified") ? journeyTime(latestActual) : nodes.some(node => node.state !== "completed") ? "未完成" : "完成时间待核实";
  return { expected, actual };
}
export function stageStatus(stage: OrderJourney["stages"][number], asOf?: string): string {
  if (stage.state !== "completed") {
    const unfinished=stage.nodes.filter(node=>node.current&&!["completed","inherited","cancelled","not_applicable"].includes(node.state));
    if(unfinished.length&&unfinished.every(node=>nodeTerminationLabel(node)))return unfinished.some(node=>nodeTerminationLabel(node)!.includes('待核'))?'已终止 · 责任时间待核':'计时已终止';
    const overdue = stage.nodes.filter(node => node.current && node.risks.includes("overdue")).sort((a,b)=>(b.overdueSeconds??0)-(a.overdueSeconds??0))[0];
    return journeyStateLabels[stage.state] + (overdue ? " · " + nodeOverdue(overdue, asOf) : "");
  }
  const nodes = stage.nodes.filter(node => node.current && node.state === "completed");
  const late = nodes.filter(node => node.completionResult === "late");
  if (late.length) return lateDuration(Math.max(...late.map(node => node.overdueSeconds ?? 0)));
  if (!nodes.length || nodes.some(node => !node.completionResult || node.completionResult === "unknown")) return "已完成 · 时效未知";
  return nodes.every(node => node.completionResult === "early") ? "提前完成" : "按时完成";
}
export function orderStatus(order: OrderJourney): string {
  if(order.display)return {closed:"已特殊结案",completed:"整单已完成",overdue:"逾期",due_soon:"临期",active:"进行中",not_started:"未启动",cancelled:"已取消"}[order.display.mainState];
  const nodes = order.stages.flatMap(stage => stage.nodes).filter(node => node.current);
  if (nodes.some(node => node.key === "packing" && node.completesOrder !== false && node.state === "completed")) return "整单已完成";
  if (nodes.some(node => node.key === "special_closure" && node.state === "completed")) return "已特殊结案";
  if (nodes.some(node => node.state === "blocked")) return "受阻";
  if (nodes.some(node => ["active", "pending"].includes(node.state))) return "进行中";
  return "未启动";
}
/** One compact representative; every parallel node remains reachable in the detail work area. */
export function representativeCockpitNodes(order:OrderJourney,filter:Partial<Pick<CockpitContext,'stage'|'node'|'state'|'risk'>>={}):JourneyNode[]{
  if(order.display&&['closed','completed','cancelled'].includes(order.display.mainState))return [];
  const stages=new Map(order.stages.map((stage,index)=>[stage.key,index]));
  const nodeOrder=new Map(JOURNEY_NODES.map((node,index)=>[node.key,index]));
  const candidates=order.stages.flatMap(stage=>stage.nodes).filter(node=>node.current&&!nodeTerminationLabel(node)&&node.stage!=="creation"&&!["completed","cancelled","inherited","not_applicable","unavailable"].includes(node.state)&&(!filter.stage||node.stage===filter.stage)&&(!filter.node||node.key===filter.node)&&(!filter.state||node.state===filter.state)&&(!filter.risk||node.risks.includes(filter.risk)));
  const working=candidates.filter(node=>["active","blocked"].includes(node.state)||node.risks.includes("overdue")||node.risks.includes("due_soon"));
  const rank=(node:JourneyNode)=>node.risks.includes("overdue")?0:node.risks.includes("due_soon")?1:2;
  const deadline=(node:JourneyNode)=>node.expectedAt?Date.parse(node.expectedPrecision==="date"?`${node.expectedAt}T00:00:00+08:00`:node.expectedAt):Infinity;
  const waiting=candidates.filter(node=>node.state==="pending"||node.records.length>0);
  const result=(working.length?working:waiting.length?waiting:candidates).sort((a,b)=>rank(a)-rank(b)||(rank(a)<2?deadline(a)-deadline(b):0)||(stages.get(a.stage)??99)-(stages.get(b.stage)??99)||(nodeOrder.get(a.key)??99)-(nodeOrder.get(b.key)??99)||a.key.localeCompare(b.key)||a.instanceId.localeCompare(b.instanceId));
  return !working.length&&!waiting.length?result.slice(0,1):result;
}
export function matchingNodes(order: OrderJourney, kpi: CockpitContext["kpi"]): JourneyNode[] {
  const nodes = order.stages.flatMap(stage => stage.nodes).filter(node=>!nodeTerminationLabel(node));
  const ids = new Set(order.hitReasons.map(reason => reason.nodeId));
  const matched = nodes.filter(node => node.current && ids.has(node.instanceId));
  if (matched.length) return matched;
  return nodes.filter(node => node.current && (["overdue", "due_soon", "blocked"].includes(kpi) ? node.risks.includes(kpi as "overdue" | "due_soon" | "blocked") : node.state === "active" || node.state === "blocked"));
}


/** Shared document pages expose one destination; history and task modes remain in their actual URL. */
export function journeyRecordIdentity(record: JourneyRecord): string {
  if (record.url && ["development", "sourcing"].includes(record.domain)) {
    return [record.domain, journeyRecordHref(record.url, {page:1,search:"",kpi:"all"}, record.mode)].join(":");
  }
  return [record.domain,record.url || record.id,record.version,record.lineId,record.mode].join(":");
}
export function uniqueJourneyEntries<T extends {record:JourneyRecord}>(entries: readonly T[]): T[] {
  const seen=new Set<string>();
  return entries.filter(entry=>{const key=journeyRecordIdentity(entry.record);if(seen.has(key))return false;seen.add(key);return true;});
}

export function journeyDocumentGroups(order: OrderJourney) {
  const entries = new Map<string, { key: string; record: JourneyRecord; label: string }>();
  for (const { record, node } of [
    ...order.stages.flatMap(stage => stage.nodes.flatMap(node => node.records.map(record => ({ record, node })))),
    ...order.links.map(record => ({ record, node: null })),
  ]) {
    const key = journeyRecordIdentity(record);
    if (entries.has(key)) continue;
    const label = [node?.subject || node?.label || "订单档案", node?.round ? `第 ${node.round} 轮` : null, node?.occurrence && node.occurrence > 1 ? `第 ${node.occurrence} 次` : null, record.version ? `v${record.version}` : null, record.lineId ? `明细 ${record.lineId.slice(-8)}` : null].filter(Boolean).join(" · ");
    const documentLabel=record.domain==='development'?`开发单 · 第 ${node?.round??new URL(record.url??'/', 'https://local.invalid').searchParams.get('round')??1} 轮`:record.domain==='budget'?`预算${record.version?` · 第 ${record.version} 版`:''}`:record.domain==='instruction'?`大货制单${record.version?` · 第 ${record.version} 版`:''}`:record.domain==='cutting'?`${order.lines.find(line=>line.id===record.lineId)?.po??'对应PO'} · 裁床单`:record.domain==='sourcing'?`外发审批 / 合同${record.version?` · 第 ${record.version} 版`:''}`:label;
    entries.set(key, {key, record, label:documentLabel});
  }
  const groups = new Map<string, Array<{ key: string; record: JourneyRecord; label: string }>>();
  for (const entry of entries.values()) groups.set(entry.record.domain, [...(groups.get(entry.record.domain) ?? []), entry]);
  return [...groups].map(([domain, entries]) => ({domain, entries}));
}

export function matchingPoDeliveryRisks(order:OrderJourney,context:CockpitContext) {
  return (order.deliveryRisks??[]).filter(risk=>(!["overdue","due_soon","blocked"].includes(context.kpi)||risk.risk===context.kpi)
    &&(!context.risk||risk.risk===context.risk)
    &&order.stages.flatMap(stage=>stage.nodes).some(node=>node.current&&node.key===risk.nodeKey&&(!context.stage||node.stage===context.stage)&&(!context.node||node.key===context.node)&&(!context.state||node.state===context.state)));
}

/** Display scope only: never feed this selection back into whole-order progress or KPI counts. */
export function journeyDetailSelection(order: OrderJourney, context: CockpitContext) {
  const nodes = order.stages.flatMap(stage => stage.nodes);
  const explicitNode = nodes.find(node => node.instanceId === context.focus)
    ?? (context.expanded === undefined ? nodes.find(node => node.key === context.node && node.current) : undefined);
  const historicalRow = nodes.find(node => node.instanceId === context.row);
  const requested = (context.expanded ?? "").split(",").filter(key => order.stages.some(stage => stage.key === key));
  const current = nodes.filter(node => node.current && node.state !== "not_applicable");
  const working = current.filter(node => !nodeTerminationLabel(node)&&(node.state === "active" || node.state === "blocked"));
  const completed = current.filter(node => node.state === "completed");
  const fallback = working[0] ?? current.find(node => node.state === "pending" && node.records.length > 0)
    ?? completed.at(-1) ?? current.find(node => node.state !== "unavailable");
  const stages = explicitNode ? requested.includes(explicitNode.stage) ? requested : [explicitNode.stage] : requested.length ? requested
    : context.expanded === "" ? [] : context.stage ? [context.stage]
    : context.round ? ["development"] : historicalRow ? [historicalRow.stage] : fallback ? [fallback.stage] : [];
  const inScope = nodes.filter(node => !stages.length || stages.includes(node.stage));
  const visible = inScope.filter(node => node.state !== "not_applicable" || node === explicitNode || node === historicalRow);
  const selected = explicitNode ?? visible.find(node => node.current && !nodeTerminationLabel(node) && ["active", "blocked"].includes(node.state))
    ?? visible.find(node => node.current && node.state === "pending" && node.records.length > 0)
    ?? visible.filter(node => node.current && node.state === "completed").at(-1)
    ?? visible.find(node => node.current && node.state !== "unavailable");
  return { stages, nodes: visible, selected };
}
