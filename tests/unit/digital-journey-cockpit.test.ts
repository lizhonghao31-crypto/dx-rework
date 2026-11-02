import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { JOURNEY_STAGES, JourneyReturnContextSchema, type JourneyNode, type OrderJourney } from "@dx-rework/contracts/digital-production-journey";
import { cockpitContext, cockpitQuery, cockpitReturnPath, journeyRecordHref, journeyTime, nodeStatus, orderStatus, stageTimes, journeyDocumentGroups, journeyDetailSelection } from "../../apps/web/src/digital-journey-cockpit-model.js";
import { DigitalJourneyCockpit } from "../../apps/web/src/digital-journey-cockpit.js";
import { canWriteDigitalTask, digitalTaskView } from "../../apps/web/src/digital-task-view.js";
import type { DigitalTask } from "@dx-rework/contracts/digital-production-tasks";
const id = "19b5331b-c76f-4b9a-8773-849e24a35ad1";
const node = (key: string, patch: Partial<JourneyNode> = {}): JourneyNode => ({ key, instanceId: key, label: key, stage: "development", state: "active", round: 1, occurrence: 1, current: true, owner: { id, name: "真实负责人" }, operator: null, assignmentHistory: [], expectedAt: null, expectedKind: "unset", expectedPrecision: "missing", actualAt: null, actualQuality: "missing", enteredAt: null, sla: "not_started", completionResult: null, overdueSeconds: null, risks: [], blockers: [], records: [], inheritedFrom: null, countsInProgress: true, unavailableReason: null, ...patch });
const order = (nodes: JourneyNode[]): OrderJourney => ({ id, sourceId: id, orderId: id, designStyleNo: "TEST-COCKPIT", temporaryStyleNo: null, customer: "TEST-PD", category: "上衣", designer: "测试设计师", styleName: null, merchandisers: [], orderNumbers: [], createdAt: "2026-10-01T00:00:00Z", deliveryDate: null, selectedRound: 1, adoptedRound: null, sourceVersion: 1, instructionVersion: null, lines: [], links: [], stages: JOURNEY_STAGES.map(stage => ({ ...stage, state: "active", nodes: nodes.filter(item => item.stage === stage.key) })), progress: { development: { completed: 0, applicable: 2 }, bulk: null }, hitReasons: [] });
describe("formal Journey cockpit", () => {
  it("preserves read intent on exact task links and blocks every write until explicit audit entry", () => {
    const context = cockpitContext("?selected=" + id);
    const url = new URL(journeyRecordHref("/ui/digital-production?task=" + id, context, "read"), "https://local.invalid");
    expect(digitalTaskView(url.search)).toBe("read");
    const task = {taskId: id, canCorrect: true} as DigitalTask;
    for (const path of [`tasks/${id}/complete`, `tasks/${id}/time-corrections`, `lifecycle/source/${id}`]) expect(canWriteDigitalTask("read", task, path)).toBe(false);
    expect(canWriteDigitalTask("correct", task, `tasks/${id}/time-corrections`)).toBe(true);
    expect(canWriteDigitalTask("correct", {...task, canCorrect: false}, `tasks/${id}/time-corrections`)).toBe(false);
    expect(canWriteDigitalTask("correct", task, `tasks/other/time-corrections`)).toBe(false);
    expect(canWriteDigitalTask("correct", task, `tasks/${id}/complete`)).toBe(false);
    expect(canWriteDigitalTask("handle", task, `tasks/${id}/complete`)).toBe(true);
    expect(cockpitReturnPath(url.search)).toContain(id);
  });
  it("round-trips filters, selection, exact round, expansion and focused node through original URLs", () => {
    const context = JourneyReturnContextSchema.parse({ search: "中文 PO", customer: "TEST-PD", kpi: "overdue", page: 2, selected: id, expanded: "development,preparation", focus: id, row: "historical-row", round: 2 });
    const href = journeyRecordHref("/ui/digital-production?development=" + id + "&round=2#material-" + id, context);
    const target = new URL(href, "https://local.invalid");
    expect(target.hash).toBe("#material-" + id);
    expect(target.searchParams.get("round")).toBe("2");
    expect(cockpitContext(new URL(cockpitReturnPath(target.search)!, "https://local.invalid").search)).toEqual(context);
    expect(cockpitQuery(context)).not.toMatch(/selected|expanded|focus|row|round|flow/);
  });
  it("rejects external or malformed return contexts and keeps the retired bulk link usable", () => {
    expect(cockpitReturnPath("?returnTo=https%3A%2F%2Fexternal.invalid")).toBeNull();
    expect(cockpitReturnPath("?returnTo=" + encodeURIComponent("/ui/digital-cockpit?selected=not-a-uuid"))).toBeNull();
    expect(cockpitReturnPath("?returnTo=" + encodeURIComponent("/ui/digital-cockpit?foreign=1"))).toBeNull();
    expect(cockpitContext("?stage=bulk&workspace=preparation").stage).toBe("preparation");
  });
  it("preserves an explicitly collapsed workflow through original-record return and reload", () => {
    const context = JourneyReturnContextSchema.parse({search: "TEST-COCKPIT", selected: id, page: 2, expanded: "", flow: "collapsed", row: ""});
    const record = new URL(journeyRecordHref("/ui/digital-production?task=" + id, context), "https://local.invalid");
    const back = new URL(cockpitReturnPath(record.search)!, "https://local.invalid");
    expect(back.searchParams.has("expanded")).toBe(true);
    expect(cockpitContext(back.search)).toEqual(context);
    expect(cockpitContext("?selected=" + id).expanded).toBeUndefined();
  });
  it("preserves date-only plans and does not invent a phase target from partial registration", () => {
    expect(journeyTime("2026-10-03", "date")).toBe("2026-10-03");
    expect(nodeStatus(node("原物料", { expectedAt: "2026-10-03", expectedPrecision: "date", state: "pending", risks: ["overdue"] }), "2026-10-04T16:30:00Z")).toContain("原计划逾期 2 天");
    const stage = order([node("纸样", { expectedAt: "2026-10-03", expectedPrecision: "date", expectedKind: "plan" }), node("裁板")]).stages[1]!;
    expect(stageTimes(stage).expected).toContain("未完整登记");
    expect(stageTimes(stage).actual).toContain("未完成");
  });
  it("keeps unverified/unknown completion, previous-round inheritance and whole-order completion distinct", () => {
    expect(nodeStatus(node("unknown", { state: "completed", completionResult: "unknown", actualQuality: "unverified" }))).toBe("已完成 · 时间未核实");
    expect(nodeStatus(node("old", { state: "inherited", inheritedFrom: { taskId: id, round: 1 } }))).toBe("沿用第 1 轮");
    expect(orderStatus(order([node("pattern", { state: "completed" })]))).not.toBe("整单已完成");
    expect(orderStatus(order([node("packing", { state: "completed", stage: "receiving" })]))).toBe("整单已完成");
  });
  it("opens a selected order without the unrelated overview and retains simultaneous original work", () => {
    const first = node("并行纸样", { records: [{ domain: "task", id, url: "/ui/digital-production?task=" + id, mode: "handle", version: 1, lineId: null }] });
    const second = node("并行预缩", { instanceId: "parallel-preshrink", stage: "preparation" });
    const denied = node("权限隔离节点", {state: "unavailable", unavailableReason: "permission", owner: null});
    const item = order([first, second, denied]);
    item.progress.bulk = { completed: 4, applicable: 9 };
    const html = renderToStaticMarkup(createElement(DigitalJourneyCockpit, { data: { ruleVersion: "journey-v2.0", asOf: "2026-10-05T00:00:00Z", page: 1, pageSize: 15, total: 1, summary: { all: 1, active: 1, dueSoon: 0, overdue: 0, blocked: 0, completed: 0 }, items: [item] }, detail: item, context: JourneyReturnContextSchema.parse({ selected: id, expanded: "development,preparation" }), error: "", detailError: "", detailLoading: false, onChange: () => undefined, actions: null }));
    for (const stage of JOURNEY_STAGES) expect(html).toContain(stage.label);
    for (const label of ["并行纸样", "并行预缩", "预计完成时间", "实际完成时间", "相关单据", "操作记录", "进入该节点办理"]) expect(html).toContain(label);
    expect(html).not.toContain('aria-label="订单列表"');
    expect(html).toContain("生产管理总览");
    expect(html).toContain("returnTo=");
    expect(html).not.toContain("交货完成");
    expect(html).toMatch(/权限隔离节点[\s\S]*无权限查看[\s\S]*无权限查看/);
    expect(html).not.toContain('class="journey-order-metrics"');
    expect(html).not.toContain('class="journey-business-tabs"');
    expect(html).not.toContain("已交货");
  });
  it("retains different historical destinations while grouping identical record references once", () => {
    const record = {domain: "development", id, url: "/ui/digital-production?development=" + id + "&round=1", mode: "read" as const, version: 1, lineId: null};
    const item = order([node("发布", {round: 1, records: [record, record]}), node("复版", {instanceId: "round-2", round: 2, records: [{...record, url: record.url.replace("round=1", "round=2"), version: 2}]})]);
    item.links = [record];
    const groups = journeyDocumentGroups(item);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.entries.map(entry => entry.record.version)).toEqual([1, 2]);
    expect(groups[0]!.entries.map(entry => entry.label)).toEqual(["开发单 · 第 1 轮", "开发单 · 第 2 轮"]);
  });
  it("does not label complete mixed-precision targets as missing or invent a phase date", () => {
    const stage = order([node("日期计划", {expectedAt: "2026-10-03", expectedPrecision: "date"}), node("办理时限", {expectedAt: "2026-10-03T08:30:00Z", expectedPrecision: "instant"})]).stages[1]!;
    expect(stageTimes(stage).expected).toBe("见各节点目标");
  });
});

describe("R2 PR07 stage display scope", () => {
  const context = (patch = {}) => JourneyReturnContextSchema.parse({selected: id, ...patch});
  it("defaults to real current work rather than the first lifecycle placeholder", () => {
    const item = order([node("placeholder", {stage: "creation", state: "uncreated"}), node("development_sewing", {stage: "development"}), node("paper", {stage: "preparation"})]);
    const result = journeyDetailSelection(item, context());
    expect(result.stages).toEqual(["development"]);expect(result.selected?.key).toBe("development_sewing");expect(result.nodes.map(n=>n.key)).toEqual(["development_sewing"]);
    expect(journeyDetailSelection(item,context({expanded:"preparation"})).selected?.key).toBe("paper");
    expect(journeyDetailSelection(item,context({expanded:"preparation",node:"development_sewing"})).selected?.key).toBe("paper");
  });
  it("honors exact historic focus, explicit phase, round and all-phase requests", () => {
    const item = order([node("old", {current:false, state:"cancelled"}),node("sewing", {stage:"preparation"})]);
    expect(journeyDetailSelection(item,context({focus:"old"})).selected?.key).toBe("old");
    expect(journeyDetailSelection(item,context({focus:"old",expanded:"development,preparation"})).stages).toEqual(["development","preparation"]);
    expect(journeyDetailSelection(item,context({stage:"development"})).stages).toEqual(["development"]);
    expect(journeyDetailSelection(item,context({round:1})).stages).toEqual(["development"]);
    expect(journeyDetailSelection(item,context({expanded:""})).nodes).toHaveLength(2);
  });
  it("keeps row expansion separate from the current task and can locate a historical row on entry", () => {
    const item=order([node("old",{state:"cancelled",current:false}),node("current")]);
    expect(journeyDetailSelection(item,context({row:"old",expanded:"development"})).selected?.key).toBe("current");
    expect(journeyDetailSelection(item,context({row:"old"})).nodes.map(n=>n.key)).toContain("old");
  });
  it("hides only not-applicable nodes, preserves unfinished and inherited facts, and never mutates progress", () => {
    const item=order([node("work"),node("no-wash",{state:"not_applicable"}),node("future",{state:"uncreated"}),node("old",{state:"inherited",current:false})]);
    const original=structuredClone(item);
    expect(journeyDetailSelection(item,context()).nodes.map(n=>n.key)).toEqual(["work","future","old"]);
    expect(journeyDetailSelection(item,context({focus:"no-wash"})).selected?.state).toBe("not_applicable");
    expect(item).toEqual(original);
  });
  it("uses the applicable ending phase after completion even when later placeholders exist", () => {
    const item=order([node("start",{state:"completed",stage:"creation"}),node("done",{state:"completed",stage:"receiving"}),node("unused",{state:"not_applicable",stage:"receiving"})]);
    expect(journeyDetailSelection(item,context()).selected?.key).toBe("done");
    expect(journeyDetailSelection(item,context()).stages).toEqual(["receiving"]);
  });
  it("uses real blocking work and retains all simultaneous tasks", () => {
    const item=order([node("placeholder",{state:"pending",stage:"creation"}),node("blocked",{state:"blocked",stage:"preparation"}),node("parallel",{stage:"preparation"})]);
    expect(journeyDetailSelection(item,context()).selected?.key).toBe("blocked");
    expect(journeyDetailSelection(item,context()).nodes.map(n=>n.key)).toEqual(["blocked","parallel"]);
  });
  it("removes only the added preparation block and exposes document directory in the existing region", () => {
    const record={domain:"development",id,url:"/ui/digital-production?development="+id+"&round=1",mode:"read" as const,version:1,lineId:null};
    const item=order([node("paper",{stage:"preparation",records:[record]})]);
    const html=renderToStaticMarkup(createElement(DigitalJourneyCockpit,{data:null,detail:item,context:context(),error:"",detailError:"",detailLoading:false,onChange(){},actions:null}));
    expect(html).not.toContain('class="journey-node-expanded"');expect(html).not.toContain('journey-preparation-reference');expect(html).not.toContain('本单资料');expect(html).toContain('class="cockpit-document-directory"');expect(html).not.toContain('订单进度 · 全单范围');expect(html).toContain('适用节点');
    expect(html).toContain('打板执行单');expect(html).toContain('真实回货与成衣QC');expect(html).toContain('装箱与数量差异');expect(html).toContain('查看全部');expect((html.match(/class="cockpit-document-priority-row"/g)??[])).toHaveLength(10);expect(html).toContain('读取中');expect(html).not.toContain('待判断');
  });
});
