import {MiscAssociationSnapshotSchema} from "@dx-rework/contracts/pattern-orders";
import type { PatternOrderDetail } from "@dx-rework/contracts/pattern-orders";
import { ApplicationError } from "../platform/errors.js";

export type PatternHistoryEvent = { event_id?:string; audit_at?:string; action: string; actor_name: string; created_at: Date; reason: string | null; after_state: { roundId?: string; acceptanceClock?:{now:string;scenarioId:string|null;revision:number}; value?: Record<string, unknown> } | null };
export type PatternHistorySelection = { round?: string | undefined; node?: PatternOrderDetail["status"] | undefined };
const decimal = (value: unknown): string | null => typeof value === "string" && /^\d+(\.\d+)?$/.test(value) ? value : null;
// Database money has up to eight fractional places. Replay without floating-point rounding.
const scale = 100000000n;
const units = (value: string) => { const [whole, fraction = ""] = value.split("."); return BigInt(whole!) * scale + BigInt(fraction.padEnd(8, "0").slice(0, 8)); };
const amountText = (value: bigint) => `${value / scale}.${(value % scale).toString().padStart(8, "0")}`;
const multiply = (a: string, b: string) => amountText(units(a) * units(b) / scale);
const sum = (values: string[]) => amountText(values.reduce((total, value) => total + units(value), 0n));

/** Reconstruct only an already-authorized projection; never return raw audit payloads. */
export function patternOrderAtNode(detail: PatternOrderDetail, selection: PatternHistorySelection, events: PatternHistoryEvent[], options: { technical: boolean; allCosts: boolean; unitPrices: Map<string, string | null>; wageEligibleAt: Map<string, string | null>; wageEligibleAuditAt?:Map<string,string|null>; attachmentAuditAt?:Map<string,string> }): PatternOrderDetail {
  if (!selection.node && !selection.round) return detail;
  const round = detail.rounds.find(item => item.roundId === (selection.round ?? detail.currentRoundId));
  if (!round) throw new ApplicationError("NOT_FOUND", "历史轮次不存在或无权查看", 404);
  const stage = selection.node ?? round.status;
  // An unfinished current node is still the live page, not a submitted historical snapshot.
  if(round.roundId===detail.currentRoundId&&stage===round.status&&!['completed','cancelled'].includes(stage))return detail;
  const node = round.nodes.find(item => item.stage === stage);
  const cutoff = node?.exitedAt ?? (stage === "completed" ? round.handedOverAt : stage === "cancelled" ? round.cancelledAt : null);
  if (!cutoff) throw new ApplicationError("NOT_FOUND", "该节点尚未完成，没有已提交的历史页面", 404);
  // Preserve microseconds from PostgreSQL. UUID tie-breaking is not chronological evidence.
  const key=(value:string)=>value.replace(/\.(\d{3})Z$/,(_match,digits:string)=>`.${digits}000Z`);
  const audit=(event:PatternHistoryEvent)=>key(event.audit_at??event.created_at.toISOString());
  const business=(event:PatternHistoryEvent)=>event.after_state?.acceptanceClock?.now??event.created_at.toISOString();
  const terminalAction = node?.exitReason === "rework" ? "rework_requested"
    : node?.exitReason === "cancelled" || stage === "cancelled" ? "cancelled"
    : stage === "pending_assignment" ? "assigned" : stage === "in_progress" ? "work_completed"
    : detail.kind === "misc" ? "confirmed" : "handed_over";
  const candidates=events.filter(event=>event.action.endsWith(`.${terminalAction}`));
  const direct=candidates.filter(event=>event.after_state?.roundId===round.roundId||terminalAction==='rework_requested'&&event.after_state?.value?.previousRoundId===round.roundId);
  // Handoff/cancellation also finalize older rounds. Use a unique event at their recorded business end.
  const terminalEvents=direct.length?direct:candidates.filter(event=>Date.parse(business(event))===Date.parse(cutoff)&&(terminalAction==='handed_over'&&round.handedOverAt===cutoff||terminalAction==='cancelled'&&round.cancelledAt===cutoff));
  const terminal=terminalEvents.length===1?terminalEvents[0]:undefined;
  let past=terminal?events.filter(event=>audit(event)<=audit(terminal)).sort((a,b)=>audit(a).localeCompare(audit(b))):[];
  const ambiguous=past.some((event,index)=>index>0&&audit(event)===audit(past[index-1]!));
  const terminalClock=terminal?.after_state?.acceptanceClock;
  const clockMismatch=terminalClock?!terminalClock.scenarioId||Date.parse(terminalClock.now)!==Date.parse(cutoff)||past.some((event,index)=>{
    const clock=event.after_state?.acceptanceClock,prior=past[index-1]?.after_state?.acceptanceClock;
    return !clock||clock.scenarioId!==terminalClock.scenarioId||!Number.isSafeInteger(clock.revision)||clock.revision<1||clock.revision>terminalClock.revision
      ||!Number.isFinite(Date.parse(clock.now))||Date.parse(clock.now)>Date.parse(terminalClock.now)
      ||!!prior&&(clock.revision<prior.revision||Date.parse(clock.now)<Date.parse(prior.now));
  }):past.some(event=>event.after_state?.acceptanceClock);
  const reason=!terminal?'缺少唯一的节点终结事件':ambiguous?'同一审计时刻的事件顺序未留证':clockMismatch?'历史场景时钟或版本证据不一致':null;
  if(reason)past=[];
  const local=past.filter(event=>event.after_state?.roundId===round.roundId);
  const has=(action:string)=>local.some(event=>event.action.endsWith(`.${action}`));
  const finalizes=(action:string,at:string|null)=>at!==null&&past.some(event=>event.action.endsWith(`.${action}`)&&Date.parse(business(event))===Date.parse(at));
  const handed=has(detail.kind==='misc'?'confirmed':'handed_over')||finalizes(detail.kind==='misc'?'confirmed':'handed_over',round.handedOverAt);
  const cancelled=has('cancelled')||finalizes('cancelled',round.cancelledAt);
  const fees=past.some(event=>event.action.endsWith('.cancel_fees_confirmed')&&Array.isArray(event.after_state?.value?.confirmedRoundIds)&&event.after_state.value.confirmedRoundIds.includes(round.roundId));
  const facts = past.filter(event => /\.(submitted|materials_changed)$/.test(event.action)).at(-1)?.after_state?.value;
  const text = (key: string) => typeof facts?.[key] === "string" ? facts[key] as string : null;
  const originalRoundId = detail.currentRoundId;
  const result = structuredClone(detail);
  result.currentRoundId = round.roundId;
  result.status = stage;
  result.styleNo = text("styleNo") ?? "历史未记录";
  result.association=MiscAssociationSnapshotSchema.safeParse(facts?.association).success?MiscAssociationSnapshotSchema.parse(facts?.association):null;
  result.taskName = text("taskName"); result.requiredDate = text("requiredDate");
  result.customer = text("customer"); result.sizeColor = text("sizeColor");
  result.referenceStyleNo = text("referenceStyleNo"); result.variant = text("variant");
  result.note = options.technical ? text("note") : null;
  result.updatedAt = cutoff;
  const assignment = local.find(event => event.action.endsWith(".assigned"));
  const agreed = decimal(assignment?.after_state?.value?.agreedAmount);
  const unitPrice = options.unitPrices.get(round.roundId) ?? null;
  // Track all segments internally so a worker's own remainder is accurate after a transfer.
  const ledger = new Map<string, { amount: string | null; hours: string | null }>();
  for (const event of local) {
    const value = event.after_state?.value ?? {};
    if (event.action.endsWith(".assigned") && typeof value.segmentId === "string") ledger.set(value.segmentId, { amount: decimal(value.agreedAmount), hours: null });
    if (event.action.endsWith(".worker_changed") && typeof value.previousSegmentId === "string" && typeof value.segmentId === "string") {
      const previous = ledger.get(value.previousSegmentId);
      const paid = decimal(value.amount), hours = decimal(value.hours);
      ledger.set(value.previousSegmentId, { amount: detail.kind === "misc" ? hours !== null && unitPrice !== null ? multiply(hours, unitPrice) : null : paid, hours });
      ledger.set(value.segmentId, { amount: detail.kind === "pattern" && previous?.amount !== null && previous?.amount !== undefined && paid !== null ? amountText(units(previous.amount) - units(paid)) : null, hours: null });
    }
    if (event.action.endsWith(".hours_recorded") && typeof value.segmentId === "string") {
      const hours = decimal(value.hours);
      ledger.set(value.segmentId, { amount: hours !== null && unitPrice !== null ? multiply(hours, unitPrice) : null, hours });
    }
    if (event.action.endsWith(".cancelled") && typeof value.stoppedSegmentId === "string") {
      const previous = ledger.get(value.stoppedSegmentId);
      const hours = decimal(value.hours) ?? previous?.hours ?? null;
      ledger.set(value.stoppedSegmentId, { amount: detail.kind === "pattern" ? decimal(value.amount) : hours !== null && unitPrice !== null ? multiply(hours, unitPrice) : null, hours });
    }
  }
  const snapshot = structuredClone(round);
  snapshot.status=stage;
  if(!has('assigned'))snapshot.assignedAt=null;
  if(!has('work_completed'))snapshot.completedAt=null;
  if(!handed)snapshot.handedOverAt=null;
  if(!cancelled){snapshot.cancelledAt=null;snapshot.stoppedAt=null;}
  if(!fees)snapshot.feeConfirmedAt=null;
  const stages=['pending_assignment','in_progress','pending_confirmation'];
  if(stages.includes(stage))snapshot.nodes=snapshot.nodes.filter(n=>stages.indexOf(n.stage)<=stages.indexOf(stage));
  snapshot.segments = snapshot.segments.filter(segment => ledger.has(segment.segmentId)).map(segment => {
    const saved = ledger.get(segment.segmentId)!;
    const ended=local.some(event=>event.action.endsWith('.worker_changed')&&event.after_state?.value?.previousSegmentId===segment.segmentId
      ||event.action.endsWith('.work_completed')&&event.after_state?.value?.segmentId===segment.segmentId
      ||event.action.endsWith('.cancelled')&&event.after_state?.value?.stoppedSegmentId===segment.segmentId);
    const wageAt=options.wageEligibleAuditAt?.get(segment.segmentId)??options.wageEligibleAt.get(segment.segmentId);
    const wageRecorded=!!wageAt&&!!terminal&&key(wageAt)<=audit(terminal);
    const miscQualified=detail.kind==='misc'&&(has('work_completed')||cancelled)&&ledger.size>0&&[...ledger.values()].every(saved=>saved.hours!==null&&saved.amount!==null);
    return { ...segment, amount: saved.amount, actualHours: saved.hours,
      endedAt: ended?segment.endedAt:null,
      wageEligible: segment.wageEligible&&wageRecorded&&ended&&(handed||fees||miscQualified),
    };
  });
  if (options.allCosts) {
    const entries = [...ledger.values()];
    const completeHours = entries.length > 0 && entries.every(entry => entry.hours !== null && entry.amount !== null);
    snapshot.actualHours = detail.kind === "misc" && completeHours ? sum(entries.map(entry => entry.hours!)) : null;
    snapshot.agreedAmount = detail.kind === "misc" ? completeHours ? sum(entries.map(entry => entry.amount!)) : null : agreed;
    snapshot.cancelledAmount = snapshot.cancelledAt ? sum(entries.flatMap(entry => entry.amount === null ? [] : [entry.amount])) : null;
  }
  const materialEvent = local.filter(event => /\.(submitted|materials_changed|rework_requested)$/.test(event.action)).at(-1);
  const value = materialEvent?.after_state?.value;
  const ids = Array.isArray(value?.attachmentIds) ? value.attachmentIds : Array.isArray(value?.attachments) ? value.attachments : [];
  result.attachments = options.technical ? result.attachments.filter(file => file.roundId === round.roundId && ids.includes(file.attachmentId) && terminal && key(options.attachmentAuditAt?.get(file.attachmentId)??file.addedAt)<=audit(terminal)).map(file => ({ ...file, active: true })) : [];
  result.rounds = [snapshot];
  result.currentWorkerName = snapshot.segments.at(-1)?.workerName ?? null;
  result.history = result.history.filter(event => past.some(saved=>saved.event_id&&event.eventId?saved.event_id===event.eventId:saved.action===event.action&&saved.created_at.toISOString()===event.at));
  delete result.developmentMakingBasis; // Current documents are never historical evidence.
  result.reworkBlockedReason=null;
  result.reworkCount = snapshot.index ?? 0;
  result.actions = { delete: false, assign: false, complete: false, handoff: false, edit: false, hours: false, rework: false, transfer: false, cancel: false, cancelFees: false };
  result.historicalView = { node: stage, at: cutoff, actorName: terminal&&!reason ? terminal.actor_name : "历史未记录", currentRoundId: originalRoundId, missingFacts: !facts,...(reason?{reason}:{}),...(terminal?.event_id&&!reason?{terminalEventId:terminal.event_id}:{}) };
  return result;
}
