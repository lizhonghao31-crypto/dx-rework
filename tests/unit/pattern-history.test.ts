import { describe, expect, it } from "vitest";
import type { PatternOrderDetail } from "@dx-rework/contracts/pattern-orders";
import { patternOrderAtNode, type PatternHistoryEvent } from "../../apps/api/src/pattern-room/order-history.js";

const time = (hour: number) => `2026-09-22T${String(hour).padStart(2, "0")}:00:00.000Z`;
const event = (hour: number, action: string, value: Record<string, unknown>): PatternHistoryEvent => ({ action: `pattern_room.order.${action}`, actor_name: "提交人", created_at: new Date(time(hour)), reason: null, after_state: { roundId: "round", value } });
const events = [event(1, "submitted", { styleNo: "原款号", requiredDate: "2026-09-30", note: "原备注", attachmentIds: ["old"] }),
  event(2, "assigned", { segmentId: "one", agreedAmount: "80" }),
  event(3, "materials_changed", { styleNo: "新款号", note: "新备注", attachmentIds: ["new"] }),
  event(4, "worker_changed", { previousSegmentId: "one", segmentId: "two", amount: "20.125" }),
  event(5, "work_completed", { segmentId: "two" }), event(6, "handed_over", { confirmedReceived: true })];
function fixture(): PatternOrderDetail {
  return { orderId: "order", orderNo: "BF-001", kind: "pattern", taskName: null, status: "completed", version: 6, styleNo: "新款号", creatorId: "creator", creatorName: "设计师", currentWorkerName: "乙", requiredDate: null, reworkCount: 0, submittedAt: time(1), updatedAt: time(6), currentRoundId: "round", customer: null, sizeColor: null, referenceStyleNo: null, variant: null, note: "新备注", canReadMaterials: true,
    rounds: [{ roundId: "round", index: 0, roundType: "initial", requestedBy: "creator", requestReason: null, status: "completed", categoryName: "衬衫", unit: "件", quantity: 2, unitPrice: "40", agreedAmount: "80", actualHours: null, assignedAt: time(2), completedAt: time(5), handedOverAt: time(6), stoppedAt: null, cancelledAt: null, cancelledAmount: null, feeConfirmedAt: null,
      segments: [{ segmentId: "one", personId: "p1", workerUserId: "u1", workerName: "甲", amount: "20.125", actualHours: null, startedAt: time(2), endedAt: time(4), wageEligible: true }, { segmentId: "two", personId: "p2", workerUserId: "u2", workerName: "乙", amount: "59.875", actualHours: null, startedAt: time(4), endedAt: time(5), wageEligible: true }],
      nodes: [{ stage: "pending_assignment", enteredAt: time(1), exitedAt: time(2), exitReason: "completed", elapsedSeconds: 3600 }, { stage: "in_progress", enteredAt: time(2), exitedAt: time(5), exitReason: "completed", elapsedSeconds: 10800 }, { stage: "pending_confirmation", enteredAt: time(5), exitedAt: time(6), exitReason: "completed", elapsedSeconds: 3600 }] }],
    attachments: ["old", "new"].map((id, i) => ({ attachmentId: id, roundId: "round", filename: `${id}.pdf`, mimeType: "application/pdf", sizeBytes: 10, active: i === 1, addedAt: time(i === 0 ? 1 : 3), reason: "资料" })),
    history: events.map(item => ({ action: item.action, actorName: item.actor_name, at: item.created_at.toISOString(), reason: null })),
    actions: { delete: true, assign: false, complete: false, handoff: false, edit: false, hours: false, rework: true, transfer: false, cancel: false, cancelFees: false } };
}
const options = { technical: true, allCosts: true, unitPrices: new Map([["round", "40"]]), wageEligibleAt: new Map([["one", time(6)], ["two", time(6)]]) };
describe("frozen-business-time native history",()=>{
  it("replays material fields and attachment identities to the real terminal event, excluding later edits in the same business second",()=>{
    const detail=fixture(),business="2026-09-15T00:00:00.000Z",round=detail.rounds[0]!;
    for(const n of round.nodes){n.enteredAt=business;n.exitedAt=business;}
    round.assignedAt=business;round.completedAt=business;round.handedOverAt=business;
    round.segments=round.segments.map(segment=>({...segment,startedAt:business,endedAt:business}));
    const history=[...events,event(7,"materials_changed",{styleNo:"后改款号",note:"后续不可回灌",attachmentIds:["late"]})].map((e,index)=>({...e,event_id:`event-${index}`,after_state:{...e.after_state!,acceptanceClock:{now:business,scenarioId:"TEST-original-scene",revision:1}}}));
    detail.styleNo="后改款号";detail.note="后续不可回灌";
    detail.attachments.push({...detail.attachments[0]!,attachmentId:"late",filename:"late.pdf",addedAt:time(7)});
    const result=patternOrderAtNode(detail,{round:"round",node:"in_progress"},history,options);
    expect(result.styleNo).toBe("新款号");expect(result.note).toBe("新备注");
    expect(result.attachments.map(file=>file.attachmentId)).toEqual(["new"]);
    expect(result.rounds[0]!.handedOverAt).toBeNull();expect(result.rounds[0]!.segments.every(segment=>!segment.wageEligible)).toBe(true);
    expect(result.historicalView?.actorName).toBe("提交人");expect(detail.note).toBe("后续不可回灌");
  });
  it("retains PostgreSQL microsecond audit order instead of treating millisecond-rounded later material as history",()=>{
    const detail=fixture(),business="2026-09-15T00:00:00.000Z";
    detail.rounds[0]!.nodes[1]!.exitedAt=business;
    const original=events.slice(0,5).map(e=>({...e,after_state:{...e.after_state!,acceptanceClock:{now:business,scenarioId:"TEST-scene",revision:1}}}));
    const complete={...original[4]!,created_at:new Date("2026-09-22T05:00:00.123Z"),audit_at:"2026-09-22T05:00:00.123100Z"};
    const late={...event(5,"materials_changed",{styleNo:"后改",attachmentIds:["old"]}),created_at:complete.created_at,audit_at:"2026-09-22T05:00:00.123200Z"};
    const saved=patternOrderAtNode(detail,{node:"in_progress"},[...original.slice(0,4),complete,late],options);
    expect(saved.styleNo).toBe("新款号");expect(saved.attachments.map(f=>f.attachmentId)).toEqual(["new"]);
    const ambiguous=patternOrderAtNode(detail,{node:"in_progress"},[...original.slice(0,4),complete,{...late,audit_at:complete.audit_at}],options);
    expect(ambiguous.styleNo).toBe("历史未记录");expect(ambiguous.attachments).toEqual([]);expect(ambiguous.historicalView?.reason).toContain("顺序未留证");
  });
  it.each(['scope','revision','business-end'])("keeps historical %s inconsistency unknown instead of borrowing current scene time",mode=>{
    const detail=fixture(),business='2026-09-15T00:00:00.000Z';detail.rounds[0]!.nodes[1]!.exitedAt=business;
    const history=events.map(e=>({...e,after_state:{...e.after_state!,acceptanceClock:{now:business,scenarioId:'TEST-original',revision:2}}}));
    if(mode==='scope')history[2]!.after_state.acceptanceClock.scenarioId='TEST-other';if(mode==='revision')history[2]!.after_state.acceptanceClock.revision=3;if(mode==='business-end')history[4]!.after_state.acceptanceClock.now='2026-09-16T00:00:00.000Z';
    const row=patternOrderAtNode(detail,{node:'in_progress'},history,options);expect(row.styleNo).toBe('历史未记录');expect(row.historicalView?.reason).toContain('时钟或版本');expect(row.attachments).toEqual([]);
  });
  it("does not present a completed current projection as the submitted historical node",()=>{
    const detail=fixture();detail.styleNo="后改款号";
    const result=patternOrderAtNode(detail,{round:"round",node:"completed"},events,options);
    expect(result.historicalView).toBeDefined();expect(result.styleNo).toBe("新款号");expect(Object.values(result.actions).every(value=>!value)).toBe(true);
  });
});

describe("board-room submitted node pages", () => {
  it("keeps the unfinished current round as the live page while completed current history is replayed",()=>{
    const current=fixture();current.status='in_progress';current.rounds[0]!.status='in_progress';current.rounds[0]!.nodes[1]!.exitedAt=null;
    expect(patternOrderAtNode(current,{round:'round'},events,options)).toBe(current);
  });
  it.each(["rework", "handoff", "cancel"] as const)("attributes a prior round's %s to the cross-round terminal event", action => {
    const detail = fixture(); detail.currentRoundId = "later-round";
    const round = detail.rounds[0]!;
    const cross = { ...event(6, action === "rework" ? "rework_requested" : action === "handoff" ? "handed_over" : "cancelled", { previousRoundId: "round" }), actor_name: "实际处理人" };
    cross.after_state!.roundId = "later-round";
    if (action === "rework") round.nodes[2]!.exitReason = "rework";
    if (action === "cancel") { round.status = "cancelled"; round.cancelledAt = time(6); }
    const history = [...events.slice(0, -1), cross];
    const node = action === "rework" ? "pending_confirmation" : action === "handoff" ? "completed" : "cancelled";
    const result = patternOrderAtNode(detail, { round: "round", node }, history, options);
    expect(result.historicalView?.actorName).toBe("实际处理人");
  });
  it("does not substitute an earlier editor or unrelated event when the terminal actor is missing", () => {
    const detail = fixture(); detail.currentRoundId = "later-round";
    const unrelated = { ...event(6, "materials_changed", {}), actor_name: "无关编辑人" };
    const result = patternOrderAtNode(detail, { round: "round", node: "completed" }, [...events.slice(0, -1), unrelated], options);
    expect(result.historicalView?.actorName).toBe("历史未记录");
  });
  it("restores submitted material fields, withdrawn attachments and original assignment before later transfers", () => {
    const original = fixture();
    const result = patternOrderAtNode(original, { node: "pending_assignment" }, events, options);
    expect(result).toMatchObject({ styleNo: "原款号", requiredDate: "2026-09-30", note: "原备注", historicalView: { at: time(2) } });
    expect(result.attachments.map(file => file.attachmentId)).toEqual(["old"]);
    expect(result.rounds[0]!.segments).toHaveLength(1);
    expect(result.rounds[0]!.segments[0]).toMatchObject({ workerName: "甲", amount: "80", endedAt: null, wageEligible: false });
    expect(result.rounds[0]!.handedOverAt).toBeNull();
    expect(Object.values(result.actions).every(value => value === false)).toBe(true);
    expect(original).toEqual(fixture());
  });
  it("keeps every actual worker and exact transferred share at the work submission", () => {
    const result = patternOrderAtNode(fixture(), { node: "in_progress" }, events, options);
    expect(result.rounds[0]!.segments.map(item => [item.workerName, Number(item.amount), item.wageEligible])).toEqual([["甲", 20.125, false], ["乙", 59.875, false]]);
    expect(result.note).toBe("新备注");
  });
  it("never widens the authorized worker or finance projection through audit payloads", () => {
    const worker = fixture();
    const round = worker.rounds[0]!;
    delete round.unitPrice; delete round.agreedAmount; delete round.actualHours; delete round.cancelledAmount;
    round.segments = round.segments.slice(1);
    const result = patternOrderAtNode(worker, { node: "in_progress" }, events, { ...options, allCosts: false });
    expect(result.rounds[0]!.segments.map(item => item.workerName)).toEqual(["乙"]);
    expect(result.rounds[0]).not.toHaveProperty("unitPrice");
    expect(result.rounds[0]).not.toHaveProperty("agreedAmount");
    const finance = patternOrderAtNode(fixture(), { node: "pending_assignment" }, events, { ...options, technical: false });
    expect(finance.note).toBeNull(); expect(finance.attachments).toEqual([]);
    expect(JSON.stringify(finance)).not.toContain("after_state");
  });
  it("preserves the miscellaneous wage flag once recorded hours and actual completion both precede the terminal event",()=>{
    const detail=fixture();detail.kind='misc';const round=detail.rounds[0]!;round.segments=round.segments.slice(0,1);round.unitPrice='40';round.actualHours='1';round.agreedAmount='40';
    const history=[events[0]!,event(2,'assigned',{segmentId:'one',agreedAmount:null}),event(3,'hours_recorded',{segmentId:'one',hours:'1'}),event(5,'work_completed',{segmentId:'one'})];
    const result=patternOrderAtNode(detail,{node:'in_progress'},history,{...options,wageEligibleAt:new Map([['one',time(5)]])});
    expect(result.rounds[0]!.segments[0]).toMatchObject({actualHours:'1',wageEligible:true});
    const laterWage=patternOrderAtNode(detail,{node:'in_progress'},history,options);expect(laterWage.rounds[0]!.segments[0]!.wageEligible).toBe(false);
  });
  it("does not backfill hours recorded after the worker completed a miscellaneous task", () => {
    const detail = fixture(); detail.kind = "misc";
    const round = detail.rounds[0]!; round.segments = round.segments.slice(0, 1);
    round.actualHours = "1.5"; round.agreedAmount = "42.8325"; round.unitPrice = "28.555";
    round.segments[0]!.actualHours = "1.5"; round.segments[0]!.amount = "42.8325";
    const miscEvents = [events[0]!, event(2, "assigned", { segmentId: "one", agreedAmount: null }), event(5, "work_completed", { segmentId: "one" }), { ...event(6, "hours_recorded", { segmentId: "one", hours: "1.5", unitPrice: "28.555" }), action: "pattern_room.misc.hours_recorded" }];
    const result = patternOrderAtNode(detail, { node: "in_progress" }, miscEvents, { ...options, unitPrices: new Map([["round", "28.555"]]) });
    expect(result.rounds[0]).toMatchObject({ actualHours: null, agreedAmount: null });
    expect(result.rounds[0]!.segments[0]).toMatchObject({ actualHours: null, amount: null, wageEligible: false });
    round.handedOverAt=time(7);round.nodes[2]!.exitedAt=time(7);
    const confirmed = patternOrderAtNode(detail, { node: "pending_confirmation" }, [...miscEvents,event(7,"confirmed",{})], { ...options, unitPrices: new Map([["round", "28.555"]]) });
    expect(Number(confirmed.rounds[0]!.agreedAmount)).toBe(42.8325);
  });
  it("rejects inaccessible rounds and unsubmitted nodes; missing history never falls back to today's fields", () => {
    expect(() => patternOrderAtNode(fixture(), { round: "other" }, events, options)).toThrow("历史轮次");
    expect(() => patternOrderAtNode(fixture(), { node: "cancelled" }, events, options)).toThrow("尚未完成");
    const result = patternOrderAtNode(fixture(), { node: "pending_assignment" }, [], options);
    expect(result.styleNo).toBe("历史未记录"); expect(result.note).toBeNull(); expect(result.attachments).toEqual([]);
    expect(result.historicalView?.missingFacts).toBe(true);
    expect(patternOrderAtNode(fixture(), {}, events, options).historicalView).toBeUndefined();
  });
});
