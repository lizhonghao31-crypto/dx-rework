import type { PatternOrderDetail } from "@dx-rework/contracts/pattern-orders";
import { ApplicationError } from "../platform/errors.js";

export type PatternHistoryEvent = { action: string; actor_name: string; created_at: Date; reason: string | null; after_state: { roundId?: string; value?: Record<string, unknown> } | null };
export type PatternHistorySelection = { round?: string | undefined; node?: PatternOrderDetail["status"] | undefined };
const decimal = (value: unknown): string | null => typeof value === "string" && /^\d+(\.\d+)?$/.test(value) ? value : null;
// Database money has up to eight fractional places. Replay without floating-point rounding.
const scale = 100000000n;
const units = (value: string) => { const [whole, fraction = ""] = value.split("."); return BigInt(whole!) * scale + BigInt(fraction.padEnd(8, "0").slice(0, 8)); };
const amountText = (value: bigint) => `${value / scale}.${(value % scale).toString().padStart(8, "0")}`;
const multiply = (a: string, b: string) => amountText(units(a) * units(b) / scale);
const sum = (values: string[]) => amountText(values.reduce((total, value) => total + units(value), 0n));

/** Reconstruct only an already-authorized projection; never return raw audit payloads. */
export function patternOrderAtNode(detail: PatternOrderDetail, selection: PatternHistorySelection, events: PatternHistoryEvent[], options: { technical: boolean; allCosts: boolean; unitPrices: Map<string, string | null>; wageEligibleAt: Map<string, string | null> }): PatternOrderDetail {
  if (!selection.node && !selection.round) return detail;
  const round = detail.rounds.find(item => item.roundId === (selection.round ?? detail.currentRoundId));
  if (!round) throw new ApplicationError("NOT_FOUND", "历史轮次不存在或无权查看", 404);
  const stage = selection.node ?? round.status;
  if (round.roundId === detail.currentRoundId && stage === round.status) return detail;
  const node = round.nodes.find(item => item.stage === stage);
  const cutoff = node?.exitedAt ?? (stage === "completed" ? round.handedOverAt : stage === "cancelled" ? round.cancelledAt : null);
  if (!cutoff) throw new ApplicationError("NOT_FOUND", "该节点尚未完成，没有已提交的历史页面", 404);
  const at = new Date(cutoff).getTime();
  const before = (time: string | null) => time !== null && new Date(time).getTime() <= at;
  const past = events.filter(event => event.created_at.getTime() <= at);
  const local = past.filter(event => event.after_state?.roundId === round.roundId);
  const terminalAction = node?.exitReason === "rework" ? "rework_requested"
    : node?.exitReason === "cancelled" || stage === "cancelled" ? "cancelled"
    : stage === "pending_assignment" ? "assigned" : stage === "in_progress" ? "work_completed"
    : detail.kind === "misc" ? "confirmed" : "handed_over";
  const terminalEvents = past.filter(event => {
    if (event.created_at.getTime() !== at || !event.action.endsWith(`.${terminalAction}`)) return false;
    if (event.after_state?.roundId === round.roundId) return true;
    if (terminalAction === "rework_requested") return event.after_state?.value?.previousRoundId === round.roundId;
    // Handoff/cancellation also finalize older rounds in the same transaction.
    return (terminalAction === "handed_over" && round.handedOverAt === cutoff)
      || (terminalAction === "cancelled" && round.cancelledAt === cutoff);
  });
  const facts = past.filter(event => /\.(submitted|materials_changed)$/.test(event.action)).at(-1)?.after_state?.value;
  const text = (key: string) => typeof facts?.[key] === "string" ? facts[key] as string : null;
  const originalRoundId = detail.currentRoundId;
  const result = structuredClone(detail);
  result.currentRoundId = round.roundId;
  result.status = stage;
  result.styleNo = text("styleNo") ?? "历史未记录";
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
  for (const key of ["assignedAt", "completedAt", "handedOverAt", "stoppedAt", "cancelledAt", "feeConfirmedAt"] as const) if (!before(snapshot[key])) snapshot[key] = null;
  snapshot.segments = snapshot.segments.filter(segment => before(segment.startedAt)).map(segment => {
    const saved = ledger.get(segment.segmentId);
    return { ...segment, amount: saved?.amount ?? null, actualHours: saved?.hours ?? null,
      endedAt: before(segment.endedAt) ? segment.endedAt : null,
      wageEligible: before(options.wageEligibleAt.get(segment.segmentId) ?? null),
    };
  });
  if (options.allCosts) {
    const entries = [...ledger.values()];
    const completeHours = entries.length > 0 && entries.every(entry => entry.hours !== null && entry.amount !== null);
    snapshot.actualHours = detail.kind === "misc" && completeHours ? sum(entries.map(entry => entry.hours!)) : null;
    snapshot.agreedAmount = detail.kind === "misc" ? completeHours ? sum(entries.map(entry => entry.amount!)) : null : agreed ?? (round.roundType === "initial" ? round.agreedAmount ?? null : null);
    snapshot.cancelledAmount = snapshot.cancelledAt ? sum(entries.flatMap(entry => entry.amount === null ? [] : [entry.amount])) : null;
  }
  const materialEvent = local.filter(event => /\.(submitted|materials_changed|rework_requested)$/.test(event.action)).at(-1);
  const value = materialEvent?.after_state?.value;
  const ids = Array.isArray(value?.attachmentIds) ? value.attachmentIds : Array.isArray(value?.attachments) ? value.attachments : [];
  result.attachments = options.technical ? result.attachments.filter(file => file.roundId === round.roundId && ids.includes(file.attachmentId) && before(file.addedAt)).map(file => ({ ...file, active: true })) : [];
  result.rounds = [snapshot];
  result.currentWorkerName = snapshot.segments.at(-1)?.workerName ?? null;
  result.history = result.history.filter(event => before(event.at));
  result.reworkCount = snapshot.index ?? 0;
  result.actions = { delete: false, assign: false, complete: false, handoff: false, edit: false, hours: false, rework: false, transfer: false, cancel: false, cancelFees: false };
  result.historicalView = { node: stage, at: cutoff, actorName: terminalEvents.length === 1 ? terminalEvents[0]!.actor_name : "历史未记录", currentRoundId: originalRoundId, missingFacts: !facts };
  return result;
}
