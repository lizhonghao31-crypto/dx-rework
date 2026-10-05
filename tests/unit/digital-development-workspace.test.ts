import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { JOURNEY_NODES, JOURNEY_STAGES, type JourneyNode, type OrderJourney } from "@dx-rework/contracts/digital-production-journey";
import { DevelopmentWorkspaceFilterSchema, PatternWorkspaceFilterSchema } from "@dx-rework/contracts/digital-development-workspace";
import { DevelopmentWorkspaceQuery, developmentView, patternTasks } from "../../apps/api/src/production-platform/development-workspace-query.js";
import type { DigitalJourneyQuery } from "../../apps/api/src/production-platform/journey-query.js";
import type { TrustedActorContext } from "../../apps/api/src/tools/repositories.js";
import { developmentWorkspaceReturnUrl } from "../../apps/web/src/development-workspace-return.js";

const node = (key: string, state: JourneyNode["state"] = "active", patch: Partial<JourneyNode> = {}): JourneyNode => {
  const definition = JOURNEY_NODES.find(node => node.key === key)!;
  const id = randomUUID();
  return {key, instanceId: id, label: definition.label, stage: definition.stage, state, round: 1, occurrence: 1, current: true, owner: null, operator: null, assignmentHistory: [], expectedAt: null, expectedKind: "unset", expectedPrecision: "missing", actualAt: null, actualQuality: "missing", enteredAt: null, sla: "not_started", completionResult: null, overdueSeconds: null, risks: [], blockers: [], records: [{domain: "task", id, url: `/ui/digital-production?task=${id}`, mode: "handle", version: 1, lineId: null}], inheritedFrom: null, countsInProgress: definition.count, unavailableReason: null, ...patch};
};
const journey = (nodes: JourneyNode[], patch: Partial<OrderJourney> = {}): OrderJourney => ({id: randomUUID(), sourceId: randomUUID(), orderId: null, designStyleNo: "TEST-view", temporaryStyleNo: null, customer: "PD", category: "上衣", designer: "TEST", styleName: null, merchandisers: [], orderNumbers: [], createdAt: "2026-10-01T00:00:00Z", deliveryDate: null, selectedRound: 1, adoptedRound: null, sourceVersion: 1, instructionVersion: null, lines: [], links: [], stages: JOURNEY_STAGES.map(stage => ({...stage, state: "active", nodes: nodes.filter(node => node.stage === stage.key)})), progress: {development: null, bulk: null}, hitReasons: [], ...patch});
const actor: TrustedActorContext = {actorId: randomUUID(), actorRoles: ["sample_designer"], authorizationCapability: "pattern_room:orders:create", authorizationCapabilities: ["pattern_room:orders:create"], requestId: "TEST-workspace"};

describe("development workspaces preserve original business facts", () => {
  it("uses publication/route facts for views, keeps inherited completion and separates a certain order from sample approval", () => {
    expect(developmentView(journey([]))).toBe("draft");
    const published = node("development_publish", "completed");
    expect(developmentView(journey([published, node("development_pattern", "pending")]))).toBe("developing");
    expect(developmentView(journey([published, node("development_pattern", "inherited", {countsInProgress: false}), node("development_shipping", "completed")]))).toBe("awaiting_order");
    const ordered = journey([node("development_publish", "uncreated"), node("customer_sample", "uncreated")], {orderId: randomUUID()});
    expect(developmentView(ordered)).toBe("ordered");
    expect(ordered.stages.flatMap(stage => stage.nodes).find(node => node.key === "customer_sample")?.state).toBe("uncreated");
  });
  it("shows only genuine current tasks, keeps simultaneous craft branches and excludes material plans/history/inherited placeholders", () => {
    const printing = node("development_printing"), embroidery = node("development_embroidery");
    const tasks = patternTasks([journey([printing, embroidery, node("development_pattern", "inherited"), node("development_cutting", "completed", {current: false}), node("development_material_supply", "pending", {instanceId: `material:${randomUUID()}:1`, records: []}), node("development_tail_check", "cancelled")])]);
    expect(tasks.map(task => [task.node.instanceId, task.group])).toEqual([[printing.instanceId, "craft"], [embroidery.instanceId, "craft"]]);
  });
  it("counts authorized archives/views before paging, rejects non-designers, and confirms only the source owner", async () => {
    const items = Array.from({length: 21}, (_, index) => journey([node("product_development", "completed", {owner: {id: actor.actorId, name: "TEST"}})], {designStyleNo: `TEST-${index}`}));
    let calls = 0;
    const query = new DevelopmentWorkspaceQuery({list: async (_actor, _filter, all) => {expect(all).toBe(true); calls++; return {asOf: "TEST", items};}} as unknown as DigitalJourneyQuery);
    const result = await query.designer(actor, DevelopmentWorkspaceFilterSchema.parse({page: 2, view: "draft"}));
    expect(result.counts).toEqual({all: 21, draft: 21, developing: 0, awaiting_order: 0, ordered: 0});
    expect(result.items).toHaveLength(1); expect(result.items[0]?.canConfirm).toBe(true);
    await expect(query.designer({...actor, actorRoles: ["pattern_room_worker"]}, DevelopmentWorkspaceFilterSchema.parse({}))).rejects.toMatchObject({statusCode: 403});
    expect(calls).toBe(1);
  });
  it("distinguishes task and archive counts and applies node risk/owner filters before pagination", async () => {
    const id = randomUUID(), owner = {id: actor.actorId, name: "TEST 主办"};
    const items = [journey([node("development_pattern", "active", {owner, risks: ["overdue"]}), node("development_cutting", "pending", {owner})], {id}), journey([node("development_pattern", "active", {risks: ["overdue"]})])];
    const query = new DevelopmentWorkspaceQuery({list: async () => ({asOf: "TEST", items})} as unknown as DigitalJourneyQuery);
    const all = await query.pattern(actor, PatternWorkspaceFilterSchema.parse({})); expect(all.total).toBe(3); expect(all.archiveTotal).toBe(2);
    const filtered = await query.pattern(actor, PatternWorkspaceFilterSchema.parse({owner: owner.id, risk: "overdue"}));
    expect(filtered.total).toBe(1); expect(filtered.counts.pattern).toBe(1); expect(filtered.counts.cutting).toBe(0);
  });
  it("accepts local validated workspace returns and rejects executable/external/duplicate or nested targets", () => {
    const task = randomUUID();
    expect(developmentWorkspaceReturnUrl(`/ui/digital-pattern-room?search=TEST&page=2&task=${task}`)).toContain(`task=${task}`);
    expect(developmentWorkspaceReturnUrl("/ui/digital-production?workspace=designer&view=ordered&page=2")).toContain("view=ordered");
    for (const value of ["//evil.invalid/ui/digital-pattern-room", "javascript:alert(1)", "/ui/digital-production?workspace=designer&returnTo=/ui/orders", "/ui/digital-pattern-room?page=1&page=2", "/ui/digital-pattern-room?task=bad", "/ui/digital-pattern-room#script"]) expect(developmentWorkspaceReturnUrl(value)).toBeNull();
  });
});
