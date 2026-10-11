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

describe("bulk paper tasks share the read-only workroom projection", () => {
  it("keeps development defaults, counts authorized bulk task IDs before paging, and omits fact-only markers", async () => {
    const owner = {id:actor.actorId,name:"TEST师傅"};
    const paper=node("development_pattern","active",{owner});
    const bulk=Array.from({length:23},()=>node("bulk_pattern","pending",{owner,enteredAt:null,sla:"not_started",risks:["due_soon"]}));
    const marker=node("bulk_marker","pending",{instanceId:"fact:marker",records:[]});
    const items=[journey([paper]),journey([...bulk,marker],{orderId:randomUUID()})];
    const query=new DevelopmentWorkspaceQuery({list:async()=>({asOf:"TEST",items})} as unknown as DigitalJourneyQuery);
    const manager={...actor,actorRoles:["pattern_room_supervisor"]};
    const original=await query.pattern(manager,PatternWorkspaceFilterSchema.parse({scope:"all"}));
    expect(original.total).toBe(1);expect(original.items[0]?.node).toEqual(paper);
    const result=await query.pattern(manager,PatternWorkspaceFilterSchema.parse({business:"bulk",scope:"all",page:2}));
    expect(result.total).toBe(23);expect(result.counts.pattern).toBe(23);expect(result.riskCounts.pattern.dueSoon).toBe(23);
    expect(result.items.map(item=>item.node.instanceId)).toEqual(bulk.slice(20).map(item=>item.instanceId));
    expect(result.items[0]?.node).toEqual(bulk[20]);expect(result.items[0]?.node.enteredAt).toBeNull();
    const combined=await query.pattern(manager,PatternWorkspaceFilterSchema.parse({business:"all",scope:"all"}));expect(combined.total).toBe(24);
    const worker={...actor,actorRoles:["pattern_room_worker"]};
    expect((await query.pattern(worker,PatternWorkspaceFilterSchema.parse({business:"bulk"}))).total).toBe(23);
    await expect(query.pattern(worker,PatternWorkspaceFilterSchema.parse({business:"bulk",scope:"all"}))).rejects.toMatchObject({statusCode:403});
  });
});

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
    const all = await query.pattern({...actor,actorRoles:["development_clerk"]}, PatternWorkspaceFilterSchema.parse({scope:"all",})); expect(all.total).toBe(3); expect(all.archiveTotal).toBe(2);
    const filtered = await query.pattern({...actor,actorRoles:["development_clerk"]}, PatternWorkspaceFilterSchema.parse({scope:"all",owner: owner.id, risk: "overdue"}));
    expect(filtered.total).toBe(1); expect(filtered.counts.pattern).toBe(1); expect(filtered.counts.cutting).toBe(0);
  });
  it("accepts local validated workspace returns and rejects executable/external/duplicate or nested targets", () => {
    const task = randomUUID();
    expect(developmentWorkspaceReturnUrl(`/ui/digital-pattern-room?search=TEST&page=2&task=${task}`)).toContain(`task=${task}`);
    expect(developmentWorkspaceReturnUrl("/ui/digital-production?workspace=designer&view=ordered&page=2")).toContain("view=ordered");
    expect(developmentWorkspaceReturnUrl(`/ui/digital-production?workspace=designer&selected=${task}&designer=TEST&startDate=2026-10-01`)).toContain(`selected=${task}`);
    expect(developmentWorkspaceReturnUrl(`/ui/digital-pattern-room?lane=craft&task=${task}&taskView=correct`)).toContain("lane=craft");
    for (const value of ["//evil.invalid/ui/digital-pattern-room", "javascript:alert(1)", "/ui/digital-production?workspace=designer&returnTo=/ui/orders", "/ui/digital-pattern-room?page=1&page=2", "/ui/digital-pattern-room?task=bad", "/ui/digital-pattern-room#script"]) expect(developmentWorkspaceReturnUrl(value)).toBeNull();
  });
  it("filters designers before totals/paging and preserves authorized facets and date semantics", async () => {
    const items = [journey([], {designer:"甲"}), journey([], {designer:"乙"})];
    const query = new DevelopmentWorkspaceQuery({list:async (_actor, filter) => {
      expect(filter.startDate).toBe("2026-10-01"); expect(filter.endDate).toBe("2026-10-02");
      return {asOf:"TEST", items};
    }} as unknown as DigitalJourneyQuery);
    const result = await query.designer(actor, DevelopmentWorkspaceFilterSchema.parse({designer:"甲",startDate:"2026-10-01",endDate:"2026-10-02"}));
    expect(result.total).toBe(1); expect(result.counts.all).toBe(1); expect(result.designers).toEqual(["乙","甲"]);
    expect(result.items[0]?.journey.designer).toBe("甲");
    expect(DevelopmentWorkspaceFilterSchema.safeParse({startDate:"2026-10-02",endDate:"2026-10-01"}).success).toBe(false);
  });
  it("groups parallel craft/washing and dispatch/sewing for display without losing task IDs or double counting", async () => {
    const printing=node("development_printing", "active", {risks:["overdue"]}), washing=node("development_washing");
    const transfer=node("development_sewing_transfer"), sewing=node("development_sewing");
    const items=[journey([printing,washing,transfer,sewing])];
    const query = new DevelopmentWorkspaceQuery({list:async () => ({asOf:"TEST",items})} as unknown as DigitalJourneyQuery);
    const craft=await query.pattern({...actor,actorRoles:["development_clerk"]}, PatternWorkspaceFilterSchema.parse({scope:"all",lane:"craft"}));
    expect(craft.items.map(item=>item.node.instanceId)).toEqual([printing.instanceId,washing.instanceId]);
    expect(craft.total).toBe(2); expect(craft.archiveTotal).toBe(1);
    expect(craft.counts.craft).toBe(1); expect(craft.counts.washing).toBe(1);
    expect(craft.risks?.map(item=>item.node.instanceId)).toEqual([printing.instanceId]);
    const work=await query.pattern({...actor,actorRoles:["development_clerk"]}, PatternWorkspaceFilterSchema.parse({scope:"all",lane:"sewing"}));
    expect(work.items.map(item=>item.node.instanceId)).toEqual([transfer.instanceId,sewing.instanceId]);
    expect(work.total).toBe(2);
  });
  it("counts every authorized risk before the 20-row preview or pagination",async()=>{
    const owner={id:actor.actorId,name:"TEST本人"};
    const items=Array.from({length:45},(_,index)=>journey([node("development_pattern","active",{owner,risks:index<25?["overdue"]:["due_soon"]})]));
    const query=new DevelopmentWorkspaceQuery({list:async()=>({asOf:"TEST",items})} as unknown as DigitalJourneyQuery);
    const result=await query.pattern(actor,PatternWorkspaceFilterSchema.parse({page:3}));
    expect(result.total).toBe(45);expect(result.counts.pattern).toBe(45);
    expect(result.riskCounts.pattern).toEqual({dueSoon:20,overdue:25});
    expect(result.items).toHaveLength(5);expect(result.risks).toHaveLength(20);
  });
  it("defaults to the actor's own effective tasks and refuses a worker's broader scope before reading",async()=>{
    let reads=0;const own=node("development_pattern","active",{owner:{id:actor.actorId,name:"TEST本人"}}),other=node("development_pattern","active",{owner:{id:randomUUID(),name:"TEST别人"}});
    const query=new DevelopmentWorkspaceQuery({list:async()=>{reads++;return{asOf:"TEST",items:[journey([own,other])]};}} as unknown as DigitalJourneyQuery);
    const worker={...actor,actorRoles:["pattern_room_worker"]};
    const result=await query.pattern(worker,PatternWorkspaceFilterSchema.parse({}));
    expect(result.items.map(item=>item.node.instanceId)).toEqual([own.instanceId]);expect(result.owners.map(person=>person.id)).toEqual([actor.actorId]);
    await expect(query.pattern(worker,PatternWorkspaceFilterSchema.parse({scope:"all"}))).rejects.toMatchObject({statusCode:403});
    await expect(query.pattern({...worker,actorRoles:["development_clerk"]},PatternWorkspaceFilterSchema.parse({scope:"dispatch"}))).rejects.toMatchObject({statusCode:403});
    expect(reads).toBe(1);
    expect((await query.pattern({...worker,actorRoles:["root_superuser"]},PatternWorkspaceFilterSchema.parse({scope:"all"}))).total).toBe(2);
  });
  it("uses original pending orders for formal dispatch without changing clerk transfer readiness",async()=>{
    const sourceId=randomUUID(),orderId=randomUUID(),transfer=node("development_sewing_transfer","pending",{owner:{id:randomUUID(),name:"TEST文员"}}),paper=node("development_pattern");
    const noPending=journey([node("development_sewing_transfer")]);
    const query=new DevelopmentWorkspaceQuery({list:async()=>({asOf:"TEST",items:[journey([paper,transfer],{sourceId}),noPending]}),pendingPatternAssignments:async(_actor,ids)=>{expect(ids).toContain(sourceId);return[{sourceId,orderId}];}} as unknown as DigitalJourneyQuery);
    const result=await query.pattern({...actor,actorRoles:["pattern_room_supervisor"]},PatternWorkspaceFilterSchema.parse({scope:"dispatch"}));
    expect(result.items).toHaveLength(1);expect(result.items[0]).toMatchObject({node:{instanceId:transfer.instanceId,state:"pending",owner:transfer.owner},nativeAssignment:{orderId}});
    expect(transfer.state).toBe("pending");expect(result.counts.dispatch).toBe(1);expect(result.counts.pattern).toBe(0);
    await expect(query.pattern({...actor,actorRoles:["production_management"]},PatternWorkspaceFilterSchema.parse({scope:"dispatch"}))).rejects.toMatchObject({statusCode:403});
  });

});
