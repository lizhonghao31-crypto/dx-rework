import {expect,it} from "vitest";
import {JOURNEY_NODES,JourneyFilterSchema,type JourneyNode,type OrderJourney} from "@dx-rework/contracts/digital-production-journey";
import {journeyDisplay,progressLabel} from "../../apps/api/src/production-platform/journey-display.js";
import {journeyStages,selectJourneys} from "../../apps/api/src/production-platform/journey-projection.js";
import {parseJourneyLogCursor} from "../../apps/api/src/production-platform/journey-log.js";
const asOf="2026-10-19T16:00:00.000Z"; // Shanghai October 20
function order(id="A"):OrderJourney{
  const nodes:JourneyNode[]=JOURNEY_NODES.map(def=>({...def,instanceId:def.key,state:def.key==="order_information"?"completed":"uncreated",current:true,round:null,occurrence:null,owner:null,operator:null,assignmentHistory:[],expectedAt:null,expectedKind:"unset",expectedPrecision:"missing",actualAt:null,actualQuality:"missing",enteredAt:null,sla:"not_started",completionResult:null,overdueSeconds:null,risks:[],blockers:[],records:[],inheritedFrom:null,countsInProgress:false,unavailableReason:null,progressApplicability:"applicable"}));
  return {id,sourceId:null,orderId:id,designStyleNo:id,temporaryStyleNo:null,customer:"PD",category:null,designer:null,styleName:null,merchandisers:[],orderNumbers:[],createdAt:asOf,deliveryDate:null,selectedRound:null,adoptedRound:null,sourceVersion:null,instructionVersion:null,lines:[],links:[],stages:journeyStages(nodes),progress:{development:null,bulk:null},hitReasons:[]};
}
const nodes=(o:OrderJourney)=>o.stages.flatMap(stage=>stage.nodes);
function date(o:OrderJourney,value:string|null){o.lines=[{id:o.id,po:"PO",color:"黑",formalStyleNo:null,temporaryStyleNo:null,orderedQuantity:1}];o.poDeliveryDates=[{lineId:o.id,position:1,poNumber:"PO",color:"黑",customerWarehouseArrivalDate:value,factoryDeliveryDate:"2026-01-01",sampleTargetDate:null}];return o;}
it("keeps the unique creation share at 1/7 even before workflow activation; time remains unavailable",()=>{
  const display=journeyDisplay(order(),asOf);
  expect(display).toMatchObject({actualRatio:1/7,actualLabel:"14.3%",mainState:"not_started",timeRatio:null,timeLabel:"时间规则待完善"});
});
it("counts business nodes once across POs and requires every applicable instance, ignoring legacy count",()=>{
  const o=order(),cut=nodes(o).find(node=>node.key==="bulk_cutting")!;
  cut.state="completed";const parallel={...cut,instanceId:"PO2",state:"active" as const};o.stages.find(stage=>stage.key==="cutting")!.nodes.push(parallel);
  expect(journeyDisplay(o,asOf).stages.find(stage=>stage.key==="cutting")).toMatchObject({applicable:1,completed:0,ratio:0});
  parallel.state="completed";expect(journeyDisplay(o,asOf).stages.find(stage=>stage.key==="cutting")?.ratio).toBe(1);
  parallel.state="active";expect(journeyDisplay(o,asOf).stages.find(stage=>stage.key==="cutting")?.ratio).toBe(0);
  parallel.state="cancelled";expect(journeyDisplay(o,asOf).stages.find(stage=>stage.key==="cutting")?.ratio).toBe(0);
});
it("distinguishes declared non-applicability, missing future nodes and unavailable denominator",()=>{
  const o=order();o.stages.find(stage=>stage.key==="cutting")!.nodes.forEach(node=>node.state="not_applicable");
  expect(journeyDisplay(o,asOf).stages.find(stage=>stage.key==="cutting")).toMatchObject({ratio:1,notApplicable:true});
  nodes(o).find(node=>node.key==="budget")!.progressApplicability="unknown";
  expect(journeyDisplay(o,asOf).actualRatio).toBeNull();
  nodes(o).find(node=>node.key==="budget")!.progressApplicability="applicable";
  o.stages.find(stage=>stage.key==="preparation")!.nodes=o.stages.find(stage=>stage.key==="preparation")!.nodes.filter(node=>node.key!=="budget");
  expect(journeyDisplay(o,asOf).actualRatio).toBeNull();
});
it("does not round unfinished progress to 100 or equate progress with business closure",()=>{
  expect(progressLabel(.99999)).toBe("99.9%");expect(progressLabel(1)).toBe("100.0%");
  const o=order();nodes(o).forEach(node=>node.state="completed");
  nodes(o).find(node=>node.key==="packing")!.state="not_applicable";nodes(o).find(node=>node.key==="special_closure")!.state="not_applicable";
  expect(journeyDisplay(o,asOf)).toMatchObject({actualRatio:1,awaitingClosure:true});
});
it("uses only shipment H for mutually exclusive order states; node risk remains separate",()=>{
  const overdue=date(order("overdue"),"2026-10-19"),due=date(order("due"),"2026-10-20"),active=date(order("active"),"2026-10-21"),notStarted=date(order("waiting"),null),closed=order("closed");
  nodes(active).find(node=>node.key==="development_pattern")!.enteredAt=asOf;
  nodes(active).find(node=>node.key==="development_pattern")!.risks=["overdue"];
  nodes(closed).find(node=>node.key==="packing")!.state="completed";
  const result=selectJourneys([active,closed,notStarted,due,overdue,order("development")].map(o=>o.id==="development"?{...o,orderId:null}:o),JourneyFilterSchema.parse({scope:"production"}),asOf);
  expect(result.summary).toMatchObject({all:5,overdue:1,dueSoon:1,active:1,notStarted:1,completed:1});
  expect(result.items.map(o=>o.id)).toEqual(["overdue","due","active","waiting","closed"]);expect(result.scopeCounts?.development).toBe(1);
  expect(journeyDisplay(active,asOf).mainState).toBe("active");
});
it("filters the complete authorized set before exclusive counts, sorting and pagination",()=>{
  const orders=Array.from({length:32},(_,i)=>date(order(String(i).padStart(2,"0")),"2026-10-20"));
  const filter=JourneyFilterSchema.parse({scope:"production",page:2,kpi:"due_soon",search:""});
  const result=selectJourneys(orders.reverse(),filter,asOf),all=selectJourneys(orders,filter,asOf,false);
  expect(result.summary.dueSoon).toBe(32);expect(result.total).toBe(32);expect(result.items.map(o=>o.id)).toEqual(all.items.slice(15,30).map(o=>o.id));
});
it("rejects a cross-order, cross-user, future or malformed event cursor",()=>{
  const encode=(patch:object={})=>Buffer.from(JSON.stringify({v:1,order:"A",actor:"user",asOf,at:"2026-10-19T12:00:00.000001Z",id:"task:00000000-0000-4000-8000-000000000001",...patch})).toString("base64url");
  expect(parseJourneyLogCursor(encode(),"A",asOf,"user").order).toBe("A");
  for(const value of [encode({order:"B"}),encode({actor:"another"}),encode({asOf:"2027-01-01T00:00:00Z"}),"broken"])expect(()=>parseJourneyLogCursor(value,"A",asOf,"user")).toThrow();
});
