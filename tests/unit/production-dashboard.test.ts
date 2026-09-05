import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import Fastify from "fastify";
import { calculateProductionProgress, inclusiveWorkdays, shanghaiDay, type ProductionProgressFacts } from "@dx-rework/domain";
import { ProductionDashboardItemSchema, type ProductionDashboardItem } from "@dx-rework/contracts";
import { ProductionDashboardService, selectDashboardPage } from "../../apps/api/src/sourcing/production-dashboard-service.js";
import { ProductionReportingService } from "../../apps/api/src/sourcing/production-reporting-service.js";
import { registerProductionDashboardRoutes } from "../../apps/api/src/sourcing/production-dashboard-routes.js";
import { canMoveProductionEvents, changedDashboardOrders, productionEventText, progressText } from "../../apps/web/src/production-dashboard-model.js";
const facts:ProductionProgressFacts={status:"in_production",quantity:100,completedQuantity:20,firstReportedOn:"2026-09-07",deliveryDate:"2026-09-11",lastUpdatedAt:"2026-09-08T01:00:00Z",completedOn:null};
const at="2026-09-08T02:00:00Z";
function item(index:number,overrides:Partial<ProductionProgressFacts>={}):ProductionDashboardItem {
  const f={...facts,...overrides};return ProductionDashboardItemSchema.parse({order:{
    productionOrderId:`00000000-0000-4000-8000-${String(index).padStart(12,"0")}`,sourcingCaseId:randomUUID(),sourceCaseArchived:false,
    decisionVersion:1,sourcingContractDocumentId:randomUUID(),contractNumber:"C01",contractVersion:1,supplierId:"10000000-0000-4000-8000-000000000001",supplierName:"一号加工厂",gender:"女装",styleName:"外套",quantity:f.quantity,completedQuantity:f.completedQuantity,
    processes:["车缝"],deliveryDate:f.deliveryDate,firstStyleNo:`STYLE-${index}`,dispatchedBy:randomUUID(),dispatchedAt:at,status:f.status,
    firstReportedOn:f.firstReportedOn,reportingState:null,timeProgress:null,progressAlert:null,
    lines:[{position:1,styleNo:`STYLE-${index}`,alternateStyleNo:null,color:"蓝",quantity:f.quantity,completedQuantity:f.completedQuantity}],
  },progress:calculateProductionProgress(f,at)});
}
describe("SSP-08 shared production calculations",()=>{
  it.each([
    ["2026-09-07","2026-09-11",5],["2026-09-11","2026-09-14",2],["2026-09-05","2026-09-06",0],
    ["2026-09-07","2026-09-07",1],["2026-09-12","2026-09-11",0],["2026-09-07","2026-09-20",10],
    ["2024-02-28","2024-03-01",3],
  ])("counts inclusive weekdays %s through %s",(start,end,count)=>expect(inclusiveWorkdays(start,end)).toBe(count));
  it.each([[40,"normal"],[20,"behind"],[19,"high_risk"],[100,"normal"]] as const)("classifies exact 0/20 point boundaries for %s units",(completedQuantity,state)=>{
    expect(calculateProductionProgress({...facts,completedQuantity},at)).toMatchObject({timeProgress:40,progressState:state});
  });
  it("does not warn before a first effective positive report",()=>{
    expect(calculateProductionProgress({...facts,firstReportedOn:null,completedQuantity:0,lastUpdatedAt:"2026-09-01T00:00:00Z"},at))
      .toMatchObject({timeProgress:null,progressState:"pending_first_report",daysWithoutUpdate:null,attention:false});
  });
  it.each([["2026-09-09T02:00:00Z",1,"high_risk"],["2026-09-10T02:00:00Z",2,"stale"],["2026-09-11T02:00:00Z",3,"stale"]])("prioritizes natural-day staleness at %s",(now,days,state)=>{
    const result=calculateProductionProgress(facts,String(now));expect(result.daysWithoutUpdate).toBe(days);expect(result.progressState).toBe(state);
    if(days===2||days===3)expect(progressText(result)).toBe(`${days}天没更新`);
  });
  it("uses Shanghai calendar days rather than elapsed 48-hour periods",()=>{
    expect(shanghaiDay("2026-09-09T16:01:00Z")).toBe("2026-09-10");
    expect(calculateProductionProgress({...facts,lastUpdatedAt:"2026-09-08T15:59:00Z"},"2026-09-09T16:01:00Z").daysWithoutUpdate).toBe(2);
  });
  it("resets the update age after an effective correction without moving production start",()=>{
    expect(calculateProductionProgress({...facts,lastUpdatedAt:"2026-09-11T01:00:00Z"},"2026-09-11T02:00:00Z"))
      .toMatchObject({daysWithoutUpdate:0,progressState:"high_risk",firstReportedOn:"2026-09-07"});
  });
  it("handles weekend-only, expired and missing plans without NaN",()=>{
    expect(calculateProductionProgress({...facts,firstReportedOn:"2026-09-05",deliveryDate:"2026-09-06"},"2026-09-05T02:00:00Z").timeProgress).toBe(0);
    expect(calculateProductionProgress({...facts,firstReportedOn:"2026-09-05",deliveryDate:"2026-09-06"},"2026-09-06T02:00:00Z").timeProgress).toBe(100);
    expect(calculateProductionProgress({...facts,deliveryDate:"2026-09-06"},at).timeProgress).toBe(100);
    expect(calculateProductionProgress({...facts,deliveryDate:null},at).timeProgress).toBeNull();
  });
  it.each(["production_completed","shipped"] as const)("freezes at completion and suppresses alerts for %s",status=>{
    const f={...facts,status,completedOn:"2026-09-08"};
    const first=calculateProductionProgress(f,"2026-09-08T04:00:00Z"),later=calculateProductionProgress(f,"2026-10-01T04:00:00Z");
    expect(later).toEqual(first);expect(later).toMatchObject({timeProgress:40,productionProgress:20,progressState:"completed",attention:false,daysWithoutUpdate:null});
  });
  it("caps both visual progress values at 100",()=>expect(calculateProductionProgress({...facts,completedQuantity:150},"2026-09-20T00:00:00Z")).toMatchObject({productionProgress:100,timeProgress:100}));
});
describe("SSP-08 complete-set selection and refresh",()=>{
  it("sorts and filters before pagination and counts the same matching set",()=>{
    const items=Array.from({length:33},(_,i)=>item(i+1,{completedQuantity:i===32?1:100}));
    const selected=selectDashboardPage(items,{});expect(selected.items[0]!.order.firstStyleNo).toBe("STYLE-33");
    expect(selected.totalCount).toBe(33);expect(selected.counts.attention).toBe(1);
    const pages=[1,2,3].flatMap(page=>selectDashboardPage(items,{page}).items);
    expect(new Set(pages.map(i=>i.order.productionOrderId)).size).toBe(33);
    expect(selectDashboardPage(items,{progressState:"high_risk"})).toMatchObject({totalCount:1,counts:{attention:1,inProduction:1}});
    expect(selectDashboardPage(items,{q:"STYLE-33"}).items).toEqual([items[32]]);
    expect(selectDashboardPage(items,{supplierId:randomUUID()}).totalCount).toBe(0);
    expect(selectDashboardPage(items,{status:"shipped"}).totalCount).toBe(0);
  });
  it("detects only new or materially changed rows after manual refresh",()=>{
    const first=item(1),second=item(2);expect(changedDashboardOrders([first],[first])).toEqual([]);
    expect(changedDashboardOrders([first],[first,second])).toEqual([second.order.productionOrderId]);
    expect(changedDashboardOrders([first],[{...first,progress:{...first.progress,productionProgress:25}}])).toEqual([first.order.productionOrderId]);
  });
  it("stops motion for fewer than three events, user pause, hover, focus and reduced motion",()=>{
    expect(canMoveProductionEvents(3,false,false,false,false)).toBe(true);
    expect(canMoveProductionEvents(2,false,false,false,false)).toBe(false);
    for(let i=0;i<4;i++){const flags=[false,false,false,false];flags[i]=true;expect(canMoveProductionEvents(3,flags[0]!,flags[1]!,flags[2]!,flags[3]!)).toBe(false);}
  });
  it("labels observed progress changes as refresh observations",()=>expect(productionEventText({id:"change",productionOrderId:randomUUID(),firstStyleNo:"A",supplierName:"厂",kind:"progress_changed",businessDate:"2026-09-08",recordedAt:at,quantity:20,previousState:"normal",progressState:"stale",daysWithoutUpdate:3})).toContain("刷新发现：进度正常 → 3天没更新"));
  it.each(["worker","warehouse_keeper","factory_payables","ie_reviewer"])("rejects %s before querying scoped facts",async role=>{
    const connect=vi.fn(),pool={connect} as unknown as Pool,service=new ProductionDashboardService(pool,new ProductionReportingService(pool));
    await expect(service.list({actorId:randomUUID(),actorRoles:[role],authorizationCapability:"sourcing:view",authorizationCapabilities:["sourcing:view"],requestId:randomUUID()})).rejects.toMatchObject({statusCode:403});expect(connect).not.toHaveBeenCalled();
  });
  it("rejects unauthorized HTTP reads and malformed filters",async()=>{
    const connect=vi.fn(),pool={connect} as unknown as Pool,app=Fastify();
    registerProductionDashboardRoutes(app,{authenticate:async()=>({id:randomUUID(),displayName:"财务",businessRoles:["factory_payables"],capabilities:["sourcing:view"]}),service:new ProductionDashboardService(pool,new ProductionReportingService(pool))});
    try{expect((await app.inject({method:"GET",url:"/production-dashboard"})).statusCode).toBe(403);
      expect((await app.inject({method:"GET",url:"/production-dashboard?page=0"})).statusCode).toBe(400);
      expect((await app.inject({method:"GET",url:"/production-dashboard?progressState=approved_by_finance"})).statusCode).toBe(400);
      expect(connect).not.toHaveBeenCalled();}finally{await app.close();}
  });
});
