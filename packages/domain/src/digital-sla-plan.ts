import { validateBusinessTime, type BusinessTime } from "./business-clock.js";

export type SlaAnchor =
  | { precision: "instant"; value: string; source: string }
  | { precision: "date"; value: string; source: string }
  | { precision: "unknown"; reason: string };
export type SlaPlanNode = {
  id: string; label: string; stage: number; parameterKey: string;
  applicable: "yes" | "no" | "unknown"; countsProgress: boolean;
  kind: "duration" | "included" | "estimate" | "order_date" | "unlimited" | "offset";
  minutes: number | null; offsetDays: number | null;
  dependsOn: string[]; anchorKey: string | null; targetKey: string | null;
  includedIn: string | null; includedPosition: "start" | "end";
};
export type SlaPlan = { nodes: SlaPlanNode[]; anchors: Record<string, SlaAnchor>; warningPercent: number; stageBufferMinutes: number };
export type SlaTime = { at: string | null; exclusive: boolean; reasons: string[] };
export type SlaPlannedNode = { id: string; start: SlaTime; end: SlaTime };
export type SlaNodeFact = {
  startedAt?: string; completedAt?: string; evidence: string;
  /** Captured when a responsibility window opens; formal changes append a new fact version. */
  standardMinutes?: number;
  /** Server-captured assessment target at completion, including unknown precision. */
  completedDeadline?: SlaTime;
  /** Existing business hold, projected only; this model never creates a new gate. */
  waitingFor?: { reason: string; source: string };
  remaining?: { minutes: number; asOf: string; validUntil: string; source: string };
};
export type SlaNodeEvaluation = SlaPlannedNode & {
  actualStart: string | null; actualEnd: string | null; deadline: SlaTime; forecast: SlaTime;
  planOverdue: boolean;
  forecastBasis: "actual" | "remaining_estimate" | "standard_window" | "plan" | "unknown";
  status: "not_applicable" | "unknown" | "not_started" | "running" | "warning" | "overdue" | "completed_on_time" | "completed_late" | "completed_unrated";
};
const MINUTE = 60000, DAY = 1440 * MINUTE;
const instant = (at: string) => {
  // Offset required: server timezone must never decide business semantics.
  if (!/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(at) || !Number.isFinite(Date.parse(at))) throw new Error("Invalid SLA instant");
  return Date.parse(at);
};
const iso = (ms: number) => new Date(ms).toISOString();
const known = (ms: number, exclusive = false): SlaTime => ({ at: iso(ms), exclusive, reasons: [] });
const missing = (...reasons: string[]): SlaTime => ({ at: null, exclusive: false, reasons: [...new Set(reasons)] });
export function slaDateBoundary(date: string): SlaTime {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Invalid SLA calendar date");
  const utc = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(utc) || iso(utc).slice(0, 10) !== date) throw new Error("Invalid SLA calendar date");
  return known(utc + DAY - 8 * 60 * MINUTE, true);
}
export function slaAnchorTime(anchor: SlaAnchor | undefined, key: string): SlaTime {
  if (!anchor) return missing(`缺少${key}`);
  if (anchor.precision === "unknown") return missing(anchor.reason);
  if (!anchor.source.trim()) throw new Error("SLA anchor evidence required");
  return anchor.precision === "date" ? slaDateBoundary(anchor.value) : known(instant(anchor.value));
}
function add(time: SlaTime, minutes: number): SlaTime {
  return time.at === null ? time : known(instant(time.at) + minutes * MINUTE, time.exclusive);
}
function maximum(times: SlaTime[], emptyReason: string): SlaTime {
  if (!times.length) return missing(emptyReason);
  if (times.some(t => t.at === null)) return missing(...times.flatMap(t => t.reasons));
  return times.reduce((a, b) => instant(a.at!) >= instant(b.at!) ? a : b);
}
/** Code-owned dependency graph. There is no user graph editor or business gate switch. */
export function orderedSlaNodes(plan: SlaPlan): SlaPlanNode[] {
  if (!Number.isInteger(plan.warningPercent) || plan.warningPercent < 1 || plan.warningPercent > 99) throw new Error("Invalid warning ratio");
  if (!Number.isSafeInteger(plan.stageBufferMinutes) || plan.stageBufferMinutes < 0) throw new Error("Invalid stage buffer");
  const nodes = new Map(plan.nodes.map(n => [n.id, n]));
  if (nodes.size !== plan.nodes.length) throw new Error("Duplicate SLA node");
  const ordered: SlaPlanNode[] = [], state = new Map<string, number>();
  function visit(id: string) {
    const n = nodes.get(id);
    if (!n) throw new Error(`Unknown SLA dependency: ${id}`);
    if (state.get(id) === 1) throw new Error("SLA dependency cycle");
    if (state.get(id) === 2) return;
    if (!n.id || !n.label || !Number.isInteger(n.stage) || n.stage < 1 || n.stage > 7) throw new Error("Invalid SLA node");
    if (new Set(n.dependsOn).size !== n.dependsOn.length) throw new Error("Duplicate SLA dependency");
    if (["duration", "included", "estimate"].includes(n.kind) && (!Number.isSafeInteger(n.minutes) || n.minutes! <= 0)) throw new Error("Invalid SLA duration");
    if (n.kind === "offset" && (!Number.isSafeInteger(n.offsetDays) || n.offsetDays! < 0)) throw new Error("Invalid SLA offset");
    if (n.kind === "included" && (!n.includedIn || n.dependsOn.length)) throw new Error("Included target must share exactly one parent window");
    if (n.kind !== "included" && n.includedIn !== null) throw new Error("Only included target may share a window");
    state.set(id, 1);
    for (const dep of [...n.dependsOn, ...(n.includedIn ? [n.includedIn] : [])]) visit(dep);
    if (n.includedIn) {
      const parent = nodes.get(n.includedIn)!;
      if (parent.kind !== "duration" || n.minutes! > parent.minutes!) throw new Error("Included target exceeds parent window");
    }
    // A successor follows the parent, never its already-included child.
    if (n.dependsOn.some(dep => nodes.get(dep)!.kind === "included")) throw new Error("Included target cannot be counted again in path");
    state.set(id, 2); ordered.push(n);
  }
  for (const n of plan.nodes) visit(n.id);
  for (const parent of plan.nodes) {
    const children = plan.nodes.filter(n => n.includedIn === parent.id && n.applicable !== "no");
    if (children.reduce((sum, n) => sum + n.minutes!, 0) > (parent.minutes ?? 0)) throw new Error("Included targets exceed parent window");
  }
  return ordered;
}
function planNode(n: SlaPlanNode, plan: SlaPlan, prior: Map<string, SlaPlannedNode>): SlaPlannedNode {
  const { anchors } = plan;
  if (n.applicable !== "yes") return { id: n.id, start: missing(n.applicable === "no" ? "不适用" : `${n.label}适用条件未确认`), end: missing(n.applicable === "no" ? "不适用" : `${n.label}适用条件未确认`) };
  // Each crossing path receives one buffer; parallel paths still merge by max, never by sum.
  const starts = n.dependsOn.map(id => add(prior.get(id)!.end, plan.nodes.find(node => node.id === id)!.stage === n.stage ? 0 : plan.stageBufferMinutes));
  if (n.anchorKey) starts.push(slaAnchorTime(anchors[n.anchorKey], n.anchorKey));
  let start = maximum(starts, `${n.label}缺少开始依据`);
  let end: SlaTime;
  if (n.kind === "included") {
    const parent = prior.get(n.includedIn!)!;
    start = n.includedPosition === "start" ? parent.start : add(parent.end, -n.minutes!);
    end = add(start, n.minutes!);
  } else if (n.kind === "order_date" || n.kind === "offset") {
    end = slaAnchorTime(anchors[n.targetKey!], n.targetKey ?? `${n.label}目标日期`);
    if (n.kind === "offset") { end = add(end, -n.offsetDays! * 1440); start = end; }
  } else if (n.kind === "unlimited") end = missing(`${n.label}无独立时限`);
  else end = add(start, n.minutes!);
  return { id: n.id, start, end };
}
export function calculateSlaPlan(plan: SlaPlan): SlaPlannedNode[] {
  const prior = new Map<string, SlaPlannedNode>();
  for (const n of orderedSlaNodes(plan)) prior.set(n.id, planNode(n, plan, prior));
  return plan.nodes.map(n => prior.get(n.id)!);
}
/** Backward constraints are suggestions, never edits of customer promises or business events. */
export function calculateSlaLatestStarts(plan: SlaPlan, requiredEnds: Record<string, SlaAnchor>): Record<string, SlaTime> {
  const ordered = orderedSlaNodes(plan), starts: Record<string, SlaTime> = {};
  for (const key of Object.keys(requiredEnds)) if (!ordered.some(n => n.id === key)) throw new Error("Unknown backward-plan target");
  for (const n of [...ordered].reverse()) {
    if (n.applicable !== "yes") { starts[n.id] = missing(`${n.label}适用条件未确定或不适用`); continue; }
    if (n.kind === "included") { starts[n.id] = missing("内含目标随父窗口倒排，不另加工时"); continue; }
    const bounds: SlaTime[] = [];
    if (requiredEnds[n.id]) bounds.push(slaAnchorTime(requiredEnds[n.id], n.id));
    for (const successor of ordered.filter(s => s.applicable === "yes" && s.dependsOn.includes(n.id))) bounds.push(add(starts[successor.id]!, successor.stage === n.stage ? 0 : -plan.stageBufferMinutes));
    if (!bounds.length || bounds.some(b => b.at === null)) { starts[n.id] = missing(`${n.label}缺少完整倒排目标`, ...bounds.flatMap(b => b.reasons)); continue; }
    const end = bounds.reduce((a, b) => instant(a.at!) <= instant(b.at!) ? a : b);
    starts[n.id] = n.kind === "duration" || n.kind === "estimate" ? add(end, -n.minutes!) : missing(`${n.label}不是可倒排固定工时`);
  }
  return starts;
}
export function slaPastDeadline(at: string, deadline: SlaTime): boolean {
  if (deadline.at === null) return false;
  return deadline.exclusive ? instant(at) >= instant(deadline.at) : instant(at) > instant(deadline.at);
}
/** Reads one captured clock; never writes status, starts work, or grants permissions. */
export function evaluateSlaPlan(plan: SlaPlan, facts: Record<string, SlaNodeFact>, time: BusinessTime): SlaNodeEvaluation[] {
  validateBusinessTime(time); const now = instant(time.now);
  const planned = new Map(calculateSlaPlan(plan).map(n => [n.id, n]));
  const result = new Map<string, SlaNodeEvaluation>();
  for (const n of orderedSlaNodes(plan)) {
    const p = planned.get(n.id)!, f = facts[n.id];
    if (f && !f.evidence.trim()) throw new Error("Actual SLA event evidence required");
    if (f?.startedAt && f.completedAt && instant(f.completedAt) < instant(f.startedAt)) throw new Error("SLA completion precedes start");
    if (f?.startedAt) instant(f.startedAt);
    if (f?.completedAt) instant(f.completedAt);
    if ((f?.startedAt && instant(f.startedAt) > now) || (f?.completedAt && instant(f.completedAt) > now)) throw new Error("Actual SLA event cannot be in the future");
    let deadline = missing(`${n.label}缺少可信开始时间`);
    if (n.kind === "order_date" || n.kind === "offset") deadline = p.end;
    else if (f?.startedAt && (n.kind === "duration" || n.kind === "included")) {
      if (f.standardMinutes !== undefined && (!Number.isSafeInteger(f.standardMinutes) || f.standardMinutes <= 0)) throw new Error("Invalid captured SLA standard");
      deadline = add(known(instant(f.startedAt)), f.standardMinutes ?? n.minutes!);
    }
    else if (n.kind === "estimate") deadline = missing("仅物流预计，不是收货硬期限");
    else if (n.kind === "unlimited") deadline = missing("无独立时限");
    if (f?.completedAt && f.completedDeadline) {
      if (f.completedDeadline.at) instant(f.completedDeadline.at);
      deadline = structuredClone(f.completedDeadline);
    }
    let status: SlaNodeEvaluation["status"] = n.applicable === "no" ? "not_applicable" : n.applicable === "unknown" ? "unknown" : "not_started";
    let forecast = missing(`${n.label}缺少有效预计依据`);
    let forecastBasis: SlaNodeEvaluation["forecastBasis"] = "unknown";
    if (n.applicable === "yes") {
      if (f?.completedAt) {
        forecast = known(instant(f.completedAt));
        forecastBasis = "actual";
        status = deadline.at === null ? "completed_unrated" : slaPastDeadline(f.completedAt, deadline) ? "completed_late" : "completed_on_time";
      } else {
        if (slaPastDeadline(time.now, deadline)) status = "overdue";
        else if (f?.startedAt) {
          status = "running";
          if (deadline.at && now >= instant(f.startedAt) + (instant(deadline.at) - instant(f.startedAt)) * plan.warningPercent / 100) status = "warning";
        }
        if (f?.waitingFor) {
          if (!f.waitingFor.reason.trim() || !f.waitingFor.source.trim()) throw new Error("Business hold evidence required");
          forecast = missing(f.waitingFor.reason);
        } else if (f?.remaining) {
          const r = f.remaining;
          if (!r.source.trim() || !Number.isSafeInteger(r.minutes) || r.minutes < 0 || instant(r.validUntil) < instant(r.asOf)) throw new Error("Invalid remaining-work estimate");
          if (instant(r.asOf) <= now && now <= instant(r.validUntil) && instant(r.asOf) + r.minutes * MINUTE >= now) { forecast = known(instant(r.asOf) + r.minutes * MINUTE); forecastBasis = "remaining_estimate"; }
          else forecast = missing(`${n.label}剩余工时预计已失效`);
        } else if (f?.startedAt) {
          // A started window is never reset when a prerequisite arrives or ownership changes.
          const target = n.kind === "estimate" ? add(known(instant(f.startedAt)), n.minutes!) : deadline;
          if (target.at && !slaPastDeadline(time.now, target)) { forecast = target; forecastBasis = "standard_window"; }
          else forecast = missing(`${n.label}窗口已过，缺少剩余工时预计`);
        } else {
          const projected = new Map([...result].map(([id, row]) => [id, { id, start: row.start, end: row.forecast }]));
          const candidate = planNode(n, plan, projected).end;
          if (candidate.at && !slaPastDeadline(time.now, candidate)) { forecast = candidate; forecastBasis = "plan"; }
          else forecast = candidate.at ? missing(`${n.label}计划时间已过，缺少新预计`) : candidate;
        }
      }
    }
    result.set(n.id, { ...p, actualStart: f?.startedAt ?? null, actualEnd: f?.completedAt ?? null, deadline, forecast, status,
      planOverdue: n.applicable === "yes" && !f?.completedAt && slaPastDeadline(time.now, p.end), forecastBasis });
  }
  return plan.nodes.map(n => result.get(n.id)!);
}
/** Equal stage weights, then equal applicable business nodes. Elapsed time has no vote. */
export function slaBusinessProgress(plan: SlaPlan, completedIds: readonly string[]) {
  orderedSlaNodes(plan);
  const done = new Set(completedIds);
  const stages = Array.from({ length: 7 }, (_, index) => {
    const nodes = plan.nodes.filter(n => n.stage === index + 1 && n.countsProgress && n.applicable !== "no");
    const knownNodes = nodes.filter(n => n.applicable === "yes");
    const complete = knownNodes.filter(n => done.has(n.id)).length;
    // Unknown applicability prevents an invented 100%; empty stages require explicit business closure upstream.
    return { stage: index + 1, total: nodes.length, completed: complete, ratio: nodes.length ? complete / nodes.length : 0,
      unknown: nodes.length - knownNodes.length };
  });
  return { stages, ratio: stages.reduce((sum, s) => sum + s.ratio / 7, 0) };
}
