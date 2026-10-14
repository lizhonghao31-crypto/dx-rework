import { describe, expect, it } from "vitest";
import { JourneyFilterSchema, JourneyReturnContextSchema, JOURNEY_STAGES, journeyReturnUrl, type JourneyNode, type OrderJourney } from "@dx-rework/contracts/digital-production-journey";
import { journeyCompletion, journeyStages, selectJourneys } from "../../apps/api/src/production-platform/journey-projection.js";
import { JOURNEY_NODES } from "../../apps/api/src/production-platform/journey-catalog.js";
const at="2026-10-04T10:00:00.000Z";
const node=(key:string,patch:Partial<JourneyNode>={}):JourneyNode=>({key,instanceId:key,label:key,stage:"development",state:"pending",current:true,round:1,occurrence:1,owner:null,operator:null,assignmentHistory:[],expectedAt:null,expectedPrecision:"missing",expectedKind:"unset",actualAt:null,actualQuality:"missing",enteredAt:null,sla:"not_started",completionResult:null,overdueSeconds:null,risks:[],blockers:[],records:[],inheritedFrom:null,countsInProgress:true,unavailableReason:null,...patch});
const item=(id:string,nodes:JourneyNode[],patch:Partial<OrderJourney>={}):OrderJourney=>({id,sourceId:id,orderId:null,designStyleNo:`STYLE-${id}`,temporaryStyleNo:"TEMP-1234",customer:"PD",category:"男装",designer:"设计师",styleName:"款名",merchandisers:[{id:"19b5331b-c76f-4b9a-8773-849e24a35ad1",name:"第二跟单"}],orderNumbers:["ORDER-TEST"],createdAt:at,deliveryDate:null,selectedRound:1,adoptedRound:1,sourceVersion:1,instructionVersion:null,lines:[{id:`${id}-PO1`,po:"PO-1",color:"黑",formalStyleNo:"FORMAL-1",temporaryStyleNo:null,orderedQuantity:100}],links:[],stages:journeyStages(nodes),progress:{development:{applicable:6,completed:1},bulk:null},hitReasons:[],...patch});
describe("V2 Journey shared query semantics",()=>{
  it("defines exactly seven stable stages and all declared subflow keys once",()=>{
    expect(JOURNEY_STAGES.map(stage=>stage.key)).toEqual(["creation","development","preparation","cutting","post_cutting","production","receiving"]);
    expect(new Set(JOURNEY_NODES.map(node=>node.key)).size).toBe(JOURNEY_NODES.length);
    expect(JOURNEY_NODES.find(node=>node.key==="sourcing_owner")?.stage).toBe("preparation");
    expect(JOURNEY_NODES.find(node=>node.key==="bulk_marker")?.count).toBe(false);
  });
  it("requires stage, state, node and risk to match the same current node",()=>{
    const order=item("one",[node("pattern",{risks:["overdue"]}),node("factory",{stage:"production",state:"blocked",risks:["blocked"]})]);
    const mismatched=selectJourneys([order],JourneyFilterSchema.parse({stage:"production",risk:"overdue"}),at);
    expect(mismatched.total).toBe(0);expect(mismatched.summary.all).toBe(0);
    expect(selectJourneys([order],JourneyFilterSchema.parse({stage:"production",state:"blocked",risk:"blocked"}),at).total).toBe(1);
  });
  it("counts one order for multiple overdue nodes and excludes history from current KPI",()=>{
    const orders=[item("one",[node("a",{state:"active",risks:["overdue"]}),node("b",{state:"active",risks:["overdue"]})]),item("two",[node("history",{current:false,state:"blocked",round:1,risks:["overdue","blocked"]}),node("current",{round:2,state:"completed"})])];
    const selected=selectJourneys(orders,JourneyFilterSchema.parse({kpi:"overdue"}),at);
    expect(selected.summary).toMatchObject({all:2,overdue:1,blocked:0});expect(selected.total).toBe(1);expect(selected.items[0]?.hitReasons).toHaveLength(2);
    expect(orders[1]?.stages.find(stage=>stage.key==="development")?.state).toBe("completed");
    expect(orders[1]?.stages.find(stage=>stage.key==="development")?.nodes).toHaveLength(2);
  });
  it("explains node filters with the matching current nodes even when they have no risk",()=>{
    const order=item("one",[node("bulk_marker",{stage:"preparation",state:"pending"}),node("cutting_gate",{stage:"preparation",state:"blocked",risks:["blocked"]}),node("factory_arrival",{stage:"production",state:"pending",risks:["overdue"]}),node("bulk_marker",{current:false,stage:"preparation",state:"pending"})]);
    const matched=selectJourneys([order],JourneyFilterSchema.parse({stage:"preparation",node:"bulk_marker",state:"pending"}),at);
    expect(matched.items[0]?.hitReasons).toEqual([{nodeId:"bulk_marker",nodeKey:"bulk_marker",stage:"preparation",risks:[]}]);
    const blocked=selectJourneys([order],JourneyFilterSchema.parse({stage:"preparation",state:"blocked",kpi:"blocked"}),at);
    expect(blocked.items[0]?.hitReasons.map(reason=>reason.nodeKey)).toEqual(["cutting_gate"]);
  });
  it("preserves the business denominator and requires whole-order packing/closure",()=>{
    const a=item("one",[node("partial-po",{state:"completed",stage:"receiving"}),node("packing",{state:"active",stage:"receiving"})]);
    const b=item("two",[node("packing",{state:"completed",stage:"receiving"}),node("pending-old",{state:"pending"})]);
    const selected=selectJourneys([a,b],JourneyFilterSchema.parse({kpi:"completed"}),at);
    expect(selected.total).toBe(1);expect(selected.items[0]?.id).toBe("two");expect(selected.summary.active).toBe(1);
    expect(a.progress).toEqual({development:{applicable:6,completed:1},bulk:null});
  });
  it("uses the same permission-scoped filtered set for KPI, pagination and export",()=>{
    const orders=Array.from({length:25},(_,index)=>item(`${index}`,[node("pattern",{state:"active",risks:["overdue"]})]));
    const filter=JourneyFilterSchema.parse({search:"第二跟单",merchandiserId:"19b5331b-c76f-4b9a-8773-849e24a35ad1",customer:"PD",startDate:"2026-10-04",endDate:"2026-10-04",kpi:"overdue",page:2});
    const list=selectJourneys(orders,filter,at),exported=selectJourneys(orders,filter,at,false);
    expect(list.total).toBe(25);expect(list.items).toHaveLength(10);expect(exported.items).toHaveLength(25);expect(list.summary).toEqual(exported.summary);
    expect(list.items.map(item=>item.id)).toEqual(exported.items.slice(15).map(item=>item.id));
    expect(selectJourneys(orders,JourneyFilterSchema.parse({search:"FORMAL-1"}),at).total).toBe(25);
    expect(selectJourneys(orders,JourneyFilterSchema.parse({search:"PO-1"}),at).total).toBe(25);
    expect(selectJourneys(orders,JourneyFilterSchema.parse({search:"款名"}),at).total).toBe(25);
  });
  it("filters current PO reminders by the same node and preserves original SLA, progress and export identity",()=>{
    const nodes=[node("production_reporting",{stage:"production",state:"active",enteredAt:at,expectedAt:at,sla:"running"}),node("packing",{stage:"receiving"})];
    const dates=[{lineId:"00000000-0000-4000-8000-000000000001",poNumber:"PO-1",color:"黑",kind:"factory" as const,date:"2026-10-01",risk:"overdue" as const,nodeKey:"production_reporting"},
      {lineId:"00000000-0000-4000-8000-000000000002",poNumber:"PO-2",color:"白",kind:"customer" as const,date:"2026-10-02",risk:"overdue" as const,nodeKey:"packing"}];
    const order=item("one",nodes,{deliveryRisks:dates}),original=structuredClone(order);
    const filter=JourneyFilterSchema.parse({stage:"production",node:"production_reporting",state:"active",risk:"overdue",kpi:"overdue",search:"PO-1"});
    const result=selectJourneys([order],filter,at);expect(result.total).toBe(1);expect(result.summary.overdue).toBe(1);
    expect(selectJourneys([order],filter,at,false).items).toEqual(result.items);
    expect(selectJourneys([order],JourneyFilterSchema.parse({stage:"development",risk:"overdue"}),at).total).toBe(0);
    expect(selectJourneys([{...order,deliveryRisks:[dates[1]!]}],filter,at).total).toBe(0);
    expect(order).toEqual(original);expect(result.items[0]!.stages).toEqual(original.stages);expect(result.items[0]!.progress).toEqual(original.progress);
  });
  it("does not forge completion results from unknown, unverified or absent expected times",()=>{
    expect(journeyCompletion(at,null,true)).toEqual({result:"unknown",overdueSeconds:null});
    expect(journeyCompletion(null,at,true)).toEqual({result:"unknown",overdueSeconds:null});
    expect(journeyCompletion(at,"2026-10-04T11:00:00Z",false)).toEqual({result:"unknown",overdueSeconds:null});
    expect(journeyCompletion(at,"2026-10-04T09:00:00Z",true)).toEqual({result:"early",overdueSeconds:0});
    expect(journeyCompletion(at,at,true)).toEqual({result:"on_time",overdueSeconds:0});
    expect(journeyCompletion(at,"2026-10-04T11:00:00Z",true)).toEqual({result:"late",overdueSeconds:3600});
  });
  it("round-trips return context and rejects foreign/unknown query keys",()=>{
    const id="19b5331b-c76f-4b9a-8773-849e24a35ad1",url=journeyReturnUrl({search:"PO 中文",page:2,stage:"preparation",kpi:"blocked",selected:id,expanded:"cutting_gate"});
    expect(url.startsWith("/ui/digital-cockpit?")).toBe(true);
    expect(JourneyReturnContextSchema.parse(Object.fromEntries(new URLSearchParams(url.split("?")[1])))).toMatchObject({search:"PO 中文",page:2,selected:id,expanded:"cutting_gate"});
    expect(JourneyReturnContextSchema.safeParse({returnTo:"https://external.invalid"}).success).toBe(false);
    expect(JourneyFilterSchema.safeParse({startDate:"2026-10-05",endDate:"2026-10-01"}).success).toBe(false);
  });
});
