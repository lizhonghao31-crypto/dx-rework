import { describe, expect, it } from "vitest";
import { digitalSlaDefaults, resolveDigitalSlaSnapshot } from "../../packages/contracts/src/digital-sla.js";
import { calculateSlaPlan, calculateSlaLatestStarts, evaluateSlaPlan, slaBusinessProgress, slaDateBoundary, slaPastDeadline,
  type SlaPlan, type SlaPlanNode } from "../../packages/domain/src/digital-sla-plan.js";
import { SystemBusinessClock, validateBusinessTime } from "../../packages/domain/src/business-clock.js";
import { buildOrderSlaRoute } from "../../apps/api/src/production-platform/sla-route.js";

const t0 = "2026-10-01T00:00:00.000Z", at = (hours: number) => new Date(Date.parse(t0) + hours * 3600000).toISOString();
const time = (hours: number) => ({ now: at(hours), scenarioId: "isolated-fixture", revision: 1 });
const node = (id: string, minutes = 60, patch: Partial<SlaPlanNode> = {}): SlaPlanNode => ({ id, label: id, parameterKey: id,
  stage: 1, applicable: "yes", countsProgress: true, kind: "duration", minutes, offsetDays: null,
  dependsOn: [], anchorKey: "start", targetKey: null, includedIn: null, includedPosition: "start", ...patch });
const plan = (nodes: SlaPlanNode[]): SlaPlan => ({ nodes, warningPercent: 70, stageBufferMinutes: 0, anchors: { start: { precision: "instant", value: t0, source: "fixture:event" } } });
const route = (washing: "yes" | "no" = "yes") => buildOrderSlaRoute(resolveDigitalSlaSnapshot({ version: 1, values: digitalSlaDefaults() }),
  { developmentCraft: "printing", washing, bulkCraft: "none" }, {
    development_published: { precision: "instant", value: t0, source: "fixture:publication" },
    customer_order_confirmed: { precision: "instant", value: t0, source: "fixture:confirmed" },
    sourcing_accepted: { precision: "instant", value: t0, source: "fixture:sourcing" },
    expected_fabric_arrival: { precision: "instant", value: t0, source: "fixture:fabric_estimate" },
  }, ["po-fixture"]);
const get = <T extends { id: string }>(items: T[], id: string) => items.find(n => n.id === id)!;
describe("complete SLA plan and frozen windows", () => {
  it("projects included start/end targets from the late actual parent window without changing P0",()=>{
    const p=plan([node("parent",1440),node("handoff",30,{kind:"included",anchorKey:null,includedIn:"parent"}),
      node("return",30,{kind:"included",anchorKey:null,includedIn:"parent",includedPosition:"end"})]);
    const rows=evaluateSlaPlan(p,{parent:{startedAt:at(10),standardMinutes:1440,evidence:"fixture:late-start"}},time(10));
    expect(get(rows,"parent").forecast.at).toBe(at(34));
    expect(get(rows,"handoff").forecast.at).toBe(at(10.5));
    expect(get(rows,"return").forecast.at).toBe(at(34));
    expect(get(rows,"handoff").start.at).toBe(t0);expect(get(rows,"handoff").end.at).toBe(at(.5));
    expect(get(rows,"return").start.at).toBe(at(23.5));expect(get(rows,"return").end.at).toBe(at(24));
    expect(get(rows,"handoff").actualStart).toBeNull();
    const done=evaluateSlaPlan(p,{parent:{completedAt:at(10),evidence:"fixture:completion-no-start"}},time(10));
    expect(get(done,"handoff").forecast.at).toBeNull();
    expect(get(done,"return").forecast.at).toBe(at(10));
  });
  it("carries a rolling start through a not-yet-started parent to included handoffs",()=>{
    const p=plan([node("prior",60),node("parent",1440,{anchorKey:null,dependsOn:["prior"]}),
      node("handoff",30,{kind:"included",anchorKey:null,includedIn:"parent"})]);
    const rows=evaluateSlaPlan(p,{prior:{startedAt:at(10),evidence:"fixture:prior-late-start"}},time(10));
    expect(get(rows,"parent").forecast.at).toBe(at(35));expect(get(rows,"handoff").forecast.at).toBe(at(11.5));
    expect(get(rows,"handoff").start.at).toBe(at(1));
    p.anchors={};
    expect(get(evaluateSlaPlan(p,{},time(10)),"handoff").forecast.at).toBeNull();
  });
  it("never presents a promised factory date as a forecast with unknown or late upstream work", () => {
    const p = plan([node("dispatch",60),node("factory",0,{kind:"order_date",minutes:null,targetKey:"delivery",anchorKey:null,dependsOn:["dispatch"]})]);
    p.anchors.delivery={precision:"instant",value:at(10),source:"fixture:promised-date"};
    delete p.anchors.start;
    const unknown=get(evaluateSlaPlan(p,{},time(0)),"factory");
    expect(unknown.end.at).toBe(at(10));expect(unknown.deadline.at).toBe(at(10));
    expect(unknown.forecast.at).toBeNull();expect(unknown.forecastBasis).toBe("unknown");
    expect(unknown.forecast.reasons.join(" ")).toContain("前置预计未知");
    p.anchors.start={precision:"instant",value:at(11),source:"fixture:late-dispatch"};
    const late=get(evaluateSlaPlan(p,{},time(0)),"factory");
    expect(late.forecast.at).toBeNull();expect(late.forecast.reasons.join(" ")).toContain("超过交期");
    p.anchors.start={precision:"instant",value:t0,source:"fixture:dispatch"};
    expect(get(evaluateSlaPlan(p,{},time(0)),"factory").forecast.at).toBeNull();
    expect(get(evaluateSlaPlan(p,{factory:{startedAt:t0,evidence:"fixture:factory-start"}},time(1)),"factory").forecast.at).toBeNull();
  });
  it("uses a fresh factory estimate or actual completion, rejects upstream estimate conflicts, and preserves the promise",()=>{
    const p=plan([node("dispatch",60),node("factory",0,{kind:"order_date",minutes:null,targetKey:"delivery",anchorKey:null,dependsOn:["dispatch"]})]);
    p.anchors.delivery={precision:"date",value:"2026-10-01",source:"fixture:promised-day"};
    const estimate={factory:{evidence:"fixture:factory-estimate",remaining:{minutes:720,asOf:t0,validUntil:at(3),source:"fixture:remaining-assessment"}}};
    const row=get(evaluateSlaPlan(p,estimate,time(0)),"factory");
    expect(row.forecast.at).toBe(at(12));expect(row.forecastBasis).toBe("remaining_estimate");expect(row.deadline.at).toBe(at(16));
    p.anchors.start={precision:"instant",value:at(15),source:"fixture:delayed-dispatch"};
    expect(get(evaluateSlaPlan(p,{},time(0)),"factory").forecast.reasons.join(" ")).toContain("超过交期");
    expect(get(evaluateSlaPlan(p,estimate,time(0)),"factory").forecast.reasons.join(" ")).toContain("晚于所报完成预计");
    delete p.anchors.start;
    expect(get(evaluateSlaPlan(p,estimate,time(0)),"factory").forecast.at).toBeNull();
    const actual=get(evaluateSlaPlan(p,{factory:{completedAt:at(17),evidence:"fixture:QC-completed"}},time(18)),"factory");
    expect(actual.forecast.at).toBe(at(17));expect(actual.forecastBasis).toBe("actual");expect(actual.status).toBe("completed_late");
    expect(actual.deadline.at).toBe(at(16));
  });
  it("preserves 201 hours including four handoffs and two independent checks", () => {
    const p = route(), rows = calculateSlaPlan(p);
    expect(get(rows, "development_tail_check").end.at).toBe(at(201));
    expect(get(rows, "development_craft_return").end.at).toBe(get(rows, "development_printing").end.at);
    expect(get(rows, "development_sewing_transfer").end.at).toBe(at(152.5));
    expect(get(rows, "development_washing_dispatch").end.at).toBe(at(177));
    expect(get(calculateSlaPlan(route("no")), "development_tail_check").end.at).toBe(at(176.5));
    const developmentOnly = { ...p, nodes: p.nodes.filter(n => ["development_materials", "development_pattern", "development_cutting", "development_printing", "development_sewing", "development_pre_wash_check", "development_washing", "development_tail_check"].includes(n.id)) };
    expect(calculateSlaLatestStarts(developmentOnly, { development_tail_check: { precision: "instant", value: at(201), source: "fixture:target" } }).development_materials?.at).toBe(t0);
  });
  it("takes the longest parallel preparation line, not the sum; no pricing dependency on pattern", () => {
    const p = route(), rows = calculateSlaPlan(p);
    expect(get(rows, "bulk_pattern").end.at).toBe(at(120));
    expect(get(rows, "sourcing_approval").end.at).toBe(at(6));
    expect(get(rows, "warehouse_preshrink").end.at).toBe(at(60));
    expect(get(rows, "bulk_cutting").end.at).toBe(at(144));
    delete p.anchors.expected_fabric_arrival;
    expect(get(calculateSlaPlan(p), "bulk_cutting").end.at).toBeNull();
    expect(get(calculateSlaPlan(p), "bulk_pattern").end.at).toBe(at(120));
    expect(get(calculateSlaPlan(p), "sourcing_approval").end.at).toBe(at(6));
  });
  it("never fabricates actual C from plan or preshrink and never restarts C after late patterns", () => {
    const p = route();
    const unknown = get(evaluateSlaPlan(p, {}, time(121)), "bulk_cutting");
    expect(unknown.actualStart).toBeNull(); expect(unknown.deadline.at).toBeNull();
    const facts = { bulk_cutting: { startedAt: at(60), standardMinutes: 1440, evidence: "fixture:explicit-real-C" } };
    const late = get(evaluateSlaPlan(p, facts, time(120)), "bulk_cutting");
    expect(late.deadline.at).toBe(at(84)); expect(late.status).toBe("overdue"); expect(late.forecast.at).toBeNull();
    p.nodes.find(n => n.id === "bulk_cutting")!.minutes = 2880;
    expect(get(evaluateSlaPlan(p, facts, time(120)), "bulk_cutting").deadline.at).toBe(at(84));
  });
  it("keeps a failed fabric inspection hold separate from checking completion", () => {
    const p = route(), facts = {
      fabric_inspection: { completedAt: at(24), evidence: "fixture:inspection-failed" },
      warehouse_preshrink: { evidence: "fixture:decision-treat-first", waitingFor: { reason: "验布不合格，先处理尚未放行", source: "fixture:quality-decision" } },
    };
    const rows = evaluateSlaPlan(p, facts, time(25));
    expect(get(rows, "warehouse_preshrink").forecast).toMatchObject({ at: null, reasons: ["验布不合格，先处理尚未放行"] });
    expect(get(rows, "bulk_cutting").forecast.at).toBeNull();
    expect(get(rows, "bulk_pattern").forecast.at).toBe(at(120));
  });
  it("adds an explicit stage buffer once per crossing path without changing actual responsibility windows", () => {
    const p = plan([node("a", 60), node("b", 120), node("next", 60, { stage: 2, anchorKey: null, dependsOn: ["a", "b"] })]);
    p.stageBufferMinutes = 30;
    expect(get(calculateSlaPlan(p), "next").end.at).toBe(at(3.5));
    expect(get(evaluateSlaPlan(p, { next: { startedAt: at(2), evidence: "fixture:next" } }, time(2.5)), "next").deadline.at).toBe(at(3));
  });
  it("distinguishes Beijing calendar-day exclusive boundary from exact-time equality", () => {
    const date = slaDateBoundary("2026-10-01");
    expect(date.at).toBe("2026-10-01T16:00:00.000Z");
    expect(slaPastDeadline("2026-10-01T15:59:59.999Z", date)).toBe(false);
    expect(slaPastDeadline("2026-10-01T16:00:00.000Z", date)).toBe(true);
    expect(slaPastDeadline(date.at!, { ...date, exclusive: false })).toBe(false);
    expect(() => slaDateBoundary("2026-02-30")).toThrow();
    const p = plan([node("factory", 0, { kind: "order_date", minutes: null, targetKey: "delivery" })]);
    p.anchors.delivery = { precision: "date", value: "2026-10-10", source: "fixture:later-approved-date" };
    const done = evaluateSlaPlan(p, { factory: { evidence: "fixture:qc", completedAt: at(17), completedDeadline: date } }, time(18))[0]!;
    expect(done.status).toBe("completed_late"); expect(done.deadline).toEqual(date);
  });
  it("uses 70% warning and retains already-completed lateness after ordinary delay", () => {
    const p = plan([node("work", 600)]), facts = { work: { startedAt: t0, evidence: "fixture:start" } };
    expect(get(evaluateSlaPlan(p, facts, time(6.999)), "work").status).toBe("running");
    expect(get(evaluateSlaPlan(p, facts, time(7)), "work").status).toBe("warning");
    expect(get(evaluateSlaPlan(p, facts, time(10)), "work").status).toBe("warning");
    expect(get(evaluateSlaPlan(p, facts, time(10.001)), "work").status).toBe("overdue");
    expect(get(evaluateSlaPlan(p, { work: { ...facts.work, completedAt: at(10), standardMinutes: 600 } }, time(20)), "work").status).toBe("completed_on_time");
    p.nodes[0]!.minutes = 1200;
    expect(get(evaluateSlaPlan(p, { work: { ...facts.work, completedAt: at(11), standardMinutes: 600 } }, time(20)), "work").status).toBe("completed_late");
  });
  it("does not turn stale remaining estimates or overdue plan dates into fresh forecasts", () => {
    const p = plan([node("work", 60)]);
    const f = { work: { startedAt: t0, evidence: "fixture:start", remaining: { minutes: 120, asOf: at(2), validUntil: at(3), source: "fixture:remaining" } } };
    expect(get(evaluateSlaPlan(p, f, time(2.5)), "work").forecast.at).toBe(at(4));
    expect(get(evaluateSlaPlan(p, f, time(3.5)), "work").forecast.at).toBeNull();
    expect(get(evaluateSlaPlan(p, {}, time(2)), "work")).toMatchObject({ planOverdue: true, actualStart: null, forecast: { at: null } });
    expect(get(evaluateSlaPlan(p, { work: { completedAt: at(5), evidence: "fixture:completion" } }, time(6)), "work").forecast.at).toBe(at(5));
  });
  it("rejects cycles, duplicate nodes/dependencies and counting an included target twice", () => {
    expect(() => calculateSlaPlan(plan([node("a", 60, { dependsOn: ["b"] }), node("b", 60, { dependsOn: ["a"] })]))).toThrow(/cycle/);
    expect(() => calculateSlaPlan(plan([node("a"), node("a")]))).toThrow(/Duplicate/);
    const p = plan([node("a"), node("included", 30, { kind: "included", includedIn: "a", anchorKey: null }), node("b", 60, { dependsOn: ["included"] })]);
    expect(() => calculateSlaPlan(p)).toThrow(/counted again/);
    p.nodes.pop(); p.nodes.push(node("included2", 40, { kind: "included", includedIn: "a", anchorKey: null }));
    expect(() => calculateSlaPlan(p)).toThrow(/exceed/);
  });
  it("never makes logistics estimate a hard deadline or ship sample a prerequisite", () => {
    const p = route();
    expect(p.nodes.some(n => n.dependsOn.some(id => id.startsWith("ship_sample")))).toBe(false);
    const f = { "return_logistics:po-fixture": { startedAt: t0, evidence: "fixture:factory-return-dispatch" } };
    const late = get(evaluateSlaPlan(p, f, time(49)), "return_logistics:po-fixture");
    expect(late.deadline.at).toBeNull(); expect(late.status).not.toBe("overdue"); expect(late.forecast.at).toBeNull();
  });
  it("weights seven stages equally and never converts elapsed time or receiving completion to 100%", () => {
    const p = plan(Array.from({ length: 7 }, (_, i) => node(`n${i}`, 60, { stage: i + 1 })));
    p.nodes.push(node("packing", 1440, { stage: 7 }));
    expect(slaBusinessProgress(p, ["n6"]).ratio).toBeCloseTo(1 / 14);
    expect(slaBusinessProgress(p, ["n0", "n6"]).ratio).toBeCloseTo(1.5 / 7);
    p.nodes[0]!.minutes = 9999;
    expect(slaBusinessProgress(p, ["n0", "n6"]).ratio).toBeCloseTo(1.5 / 7);
    expect(slaBusinessProgress(p, p.nodes.map(n => n.id)).ratio).toBeCloseTo(1);
  });
  it("keeps the production clock real and rejects malformed scenario observations", async () => {
    const before = Date.now(), observed = await new SystemBusinessClock().read({ kind: "order", id: "fixture" });
    expect(Date.parse(observed.now)).toBeGreaterThanOrEqual(before);
    expect(observed).toMatchObject({ scenarioId: null, revision: 0 });
    expect(() => validateBusinessTime({ now: t0, scenarioId: "fixture", revision: 0 })).toThrow();
    expect(() => validateBusinessTime({ now: "invalid", scenarioId: null, revision: 0 })).toThrow();
  });
});
