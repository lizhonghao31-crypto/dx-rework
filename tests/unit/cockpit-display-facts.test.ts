import {expect,it} from "vitest";
import {JOURNEY_COVERAGE_KEYS,JOURNEY_NODES,JourneyFilterSchema,type JourneyNode,type OrderJourney} from "@dx-rework/contracts/digital-production-journey";
import {journeyDisplay,progressLabel} from "../../apps/api/src/production-platform/journey-display.js";
import {journeyStages,selectJourneys} from "../../apps/api/src/production-platform/journey-projection.js";
import {parseJourneyLogCursor} from "../../apps/api/src/production-platform/journey-log.js";
const asOf="2026-10-19T16:00:00.000Z"; // Shanghai October 20
function order(id="A"):OrderJourney{
  const nodes:JourneyNode[]=JOURNEY_NODES.map(def=>({...def,instanceId:def.key,state:def.key==="order_information"?"completed":"uncreated",current:true,round:null,occurrence:null,owner:null,operator:null,assignmentHistory:[],expectedAt:null,expectedKind:"unset",expectedPrecision:"missing",actualAt:null,actualQuality:"missing",enteredAt:null,sla:"not_started",completionResult:null,overdueSeconds:null,risks:[],blockers:[],records:[],inheritedFrom:null,countsInProgress:false,unavailableReason:null,progressApplicability:"applicable"}));
  return {id,sourceId:null,orderId:id,designStyleNo:id,temporaryStyleNo:null,customer:"PD",category:null,designer:null,styleName:null,merchandisers:[],orderNumbers:[],createdAt:asOf,deliveryDate:null,selectedRound:null,adoptedRound:null,sourceVersion:null,instructionVersion:null,lines:[],links:[],stages:journeyStages(nodes),progress:{development:null,bulk:null},hitReasons:[]};
}
const nodes=(o:OrderJourney)=>o.stages.flatMap(stage=>stage.nodes);
it('keeps read-only series plan rows out of original execution shares, activation and stage state',()=>{
  const o=order(),before=journeyDisplay(o,asOf),beforeStages=o.stages.map(s=>s.state);
  for(const n of nodes(o).filter(n=>n.key.startsWith('series_'))){n.state='active';n.enteredAt=asOf;n.progressApplicability='unknown';n.risks=['overdue'];n.records=[{domain:'series-plan',id:'TEST',url:null,mode:'read',version:1,lineId:null}];}
  expect(journeyDisplay(o,asOf)).toEqual(before);expect(journeyStages(nodes(o)).map(s=>s.state)).toEqual(beforeStages);
  o.stages.forEach(s=>s.nodes=s.nodes.filter(n=>!n.key.startsWith('series_')));expect(journeyDisplay(o,asOf)).toEqual(before);
});
function date(o:OrderJourney,value:string|null){o.lines=[{id:o.id,po:"PO",color:"黑",formalStyleNo:null,temporaryStyleNo:null,orderedQuantity:1}];o.poDeliveryDates=[{lineId:o.id,position:1,poNumber:"PO",color:"黑",customerWarehouseArrivalDate:value,factoryDeliveryDate:"2026-01-01",sampleTargetDate:null}];return o;}
it("keeps the unique creation share at 1/7 even before workflow activation; time remains unavailable",()=>{
  const display=journeyDisplay(order(),asOf);
  expect(display).toMatchObject({actualRatio:1/7,actualLabel:"14.3%",mainState:"not_started",timeRatio:null,timeLabel:"沿原任务截止监督"});
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
it("does not turn unused production stages into progress for an unstarted development archive",()=>{
  const o=order();o.orderId=null;o.sourceId=o.id;
  nodes(o).forEach(node=>{node.state=node.stage==="development"?"uncreated":node.stage==="creation"?"completed":"not_applicable";});
  expect(journeyDisplay(o,asOf)).toMatchObject({mainState:"not_started",actualRatio:0,actualLabel:"0.0%",awaitingClosure:false});
  nodes(o).filter(node=>node.stage==="development").forEach(node=>node.state="completed");
  expect(journeyDisplay(o,asOf)).toMatchObject({actualRatio:1,actualLabel:"100.0%",awaitingClosure:false});
});
it("retains unknown production progress and identifies its stages even after authoritative closure",()=>{
  const o=order();nodes(o).find(node=>node.key==="packing")!.state="completed";
  nodes(o).find(node=>node.key==="rework_review")!.progressApplicability="unknown";
  const display=journeyDisplay(o,asOf);expect(display).toMatchObject({mainState:"completed",actualRatio:null,awaitingClosure:false});
  expect(display.actualLabel).toContain("回货与装箱");expect(display.stages[0]?.ratio).toBe(1);
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

it('R3 missing-time KPI and every category drill share distinct full-range orders across pages and original filters',()=>{
 const merchandiser='00000000-0000-4000-8000-000000000099';
 const orders=Array.from({length:32},(_,i)=>{
  const o=date(order('TEST-'+String(i).padStart(2,'0')),'2026-10-20');o.category='上衣';o.merchandisers=[{id:merchandiser,name:'TEST跟单'}];
  o.supervision={asOf,status:'legacy_unenrolled',originalRevision:null,currentRevision:null,nodes:[],customerReminderDate:null,coverage:[{key:'factory_date',message:'TEST原工厂日期缺项'},{key:JOURNEY_COVERAGE_KEYS[i%7]!,message:'TEST原分类'},{key:'factory_date',message:'TEST重复原证据'}]};
  if(i===31){nodes(o).find(n=>n.key==='packing')!.state='completed';o.supervision.coverage.push({key:'fact_time',message:'TEST已收口原事实矛盾'});}
  return o;
 });
 const other=date(order('TEST-other'),'2026-10-20');other.customer='PE';const source={...orders[0]!,id:'TEST-source',orderId:null};
 const input=[...orders,orders[0]!,other,source],before=JSON.stringify(input),filter=JourneyFilterSchema.parse({scope:'production',search:'TEST-',customer:'PD',category:'上衣',merchandiserId:merchandiser,stage:'preparation'});
 const result=selectJourneys(input,filter,asOf);expect(result.summary).toMatchObject({all:32,timingMissing:32,completed:1});expect(result.total).toBe(32);
 for(const key of JOURNEY_COVERAGE_KEYS){
  const count=result.supervision!.coverage.find(row=>row.key===key)?.orders??0,all=selectJourneys(input,{...filter,missing:key},asOf,false);
  expect(all.total,key).toBe(count);expect(new Set(all.items.map(o=>o.id)).size,key).toBe(count);
 }
 const pages=[1,2,3].flatMap(page=>selectJourneys(input,{...filter,missing:'factory_date',page},asOf).items.map(o=>o.id));
 expect(pages).toHaveLength(31);expect(new Set(pages).size).toBe(31);expect(pages).not.toContain(orders[31]!.id);expect(JSON.stringify(input)).toBe(before);
});

it('R3 closed coverage is counted and reachable only for original fact-time contradictions',()=>{
 const closed=date(order('TEST-closed'),'2026-10-19');nodes(closed).find(n=>n.key==='packing')!.state='completed';
 closed.supervision={asOf,status:'legacy_unenrolled',originalRevision:null,currentRevision:null,nodes:[],customerReminderDate:null,coverage:[{key:'customer_date',message:'TEST旧缺项'},{key:'fact_time',message:'TEST原实际时间矛盾'}]};
 const filter=JourneyFilterSchema.parse({scope:'production'}),result=selectJourneys([closed],filter,asOf);
 expect(result.summary.timingMissing).toBe(1);expect(result.supervision!.coverage).toEqual([{key:'fact_time',orders:1,message:'TEST原实际时间矛盾'}]);
 expect(selectJourneys([closed],{...filter,missing:'customer_date'},asOf).total).toBe(0);expect(selectJourneys([closed],{...filter,missing:'fact_time'},asOf).total).toBe(1);
 closed.supervision.coverage=closed.supervision.coverage.filter(row=>row.key!=='fact_time');expect(selectJourneys([closed],filter,asOf).summary.timingMissing).toBe(0);
});
it('separates special closure from delivered completion and stops treating it as active work',()=>{
 const o=date(order('TEST-closed'),'2026-10-01');
 nodes(o).find(n=>n.key==='special_closure')!.state='completed';
 nodes(o).find(n=>n.key==='bulk_cutting')!.state='blocked';
 nodes(o).find(n=>n.key==='bulk_cutting')!.risks=['overdue'];
 o.supervision={asOf,status:'legacy_unenrolled',originalRevision:null,currentRevision:null,nodes:[],customerReminderDate:null,coverage:[{key:'factory_date',message:'旧缺项'}]};
 o.display=journeyDisplay(o,asOf,{closedAt:asOf});
 expect(o.display).toMatchObject({mainState:'closed',awaitingClosure:false});
 const result=selectJourneys([o],JourneyFilterSchema.parse({scope:'production'}),asOf);
 expect(result.summary.completed).toBe(0);expect(result.summary.overdue).toBe(0);
 expect(result.summary.active).toBe(0);expect(result.summary.blocked).toBe(0);expect(result.summary.timingMissing).toBe(0);expect(result.supervision?.overdue).toBe(0);
 nodes(o).find(n=>n.key==='packing')!.state='completed';
 expect(journeyDisplay(o,asOf).mainState).toBe('completed');
});
