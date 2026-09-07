import Fastify from "fastify";
import {describe,expect,it,vi} from "vitest";
import {ProductionAnalysisQuerySchema,type SourcingProductionOrder} from "@dx-rework/contracts";
import {productionDueBucket,selectProductionAnalysisOrders,mayReadProductionQuality} from "../../apps/api/src/sourcing/production-analysis.js";
import {canReadProductionAnalysis} from "../../apps/web/src/production-analysis-model.js";
import {registerProductionDashboardRoutes} from "../../apps/api/src/sourcing/production-dashboard-routes.js";
import type {ProductionDashboardService} from "../../apps/api/src/sourcing/production-dashboard-service.js";
import type {AuthUser} from "../../apps/api/src/auth/service.js";
describe("production analysis boundaries",()=>{
  it.each([[null,"missing"],["2026-09-06","overdue"],["2026-09-07","soon"],["2026-09-14","soon"],["2026-09-15","later"]] as const)("classifies %s",(deliveryDate,expected)=>expect(productionDueBucket({status:"in_production",deliveryDate},"2026-09-07")).toBe(expected));
  it("does not keep completed or shipped orders overdue",()=>{
    for(const status of ["production_completed","shipped"] as const)expect(productionDueBucket({status,deliveryDate:"2026-09-01"},"2026-09-07")).toBe("closed");
  });
  it("rejects invalid dates, backwards ranges and unknown export",()=>{
    for(const input of [{dueFrom:"2026-02-30"},{dueFrom:"2026-09-07",dueTo:"2026-09-01"},{export:true},{page:0}])expect(ProductionAnalysisQuerySchema.safeParse(input).success).toBe(false);
  });
  it("filters suppliers by stable ID without merging identical names",()=>{
    const one={productionOrderId:"a",supplierId:"10000000-0000-4000-8000-000000000001",supplierName:"同名",status:"in_production",deliveryDate:null,lines:[{styleNo:"A"}]} as SourcingProductionOrder;
    const two={...one,productionOrderId:"b",supplierId:"10000000-0000-4000-8000-000000000002"};
    expect(selectProductionAnalysisOrders([one,two],ProductionAnalysisQuerySchema.parse({supplierId:two.supplierId}),"2026-09-07")).toEqual([two]);
  });
  it("requires both UI role and capability; production read does not unlock quality",()=>{
    expect(canReadProductionAnalysis({businessRoles:["production_management"],capabilities:["sourcing:view"]})).toBe(true);
    expect(canReadProductionAnalysis({businessRoles:["production_reporter"],capabilities:["production-reporting"]})).toBe(true);
    for(const role of ["worker","warehouse_receiver","finance","ie_reviewer","system_admin"])expect(canReadProductionAnalysis({businessRoles:[role],capabilities:["sourcing:view","production-reporting"]})).toBe(false);
    expect(canReadProductionAnalysis({businessRoles:["production_management"],capabilities:[]})).toBe(false);
    expect(mayReadProductionQuality({actorId:"a",actorRoles:["production_reporter"],authorizationCapability:"production-reporting",requestId:"r"})).toBe(false);
  });
  it("rejects a session without business role before calling analysis",async()=>{
    const app=Fastify(),analysis=vi.fn();
    registerProductionDashboardRoutes(app,{authenticate:async()=>({id:"a",businessRoles:[],capabilities:[]}) as unknown as AuthUser,service:{analysis} as unknown as ProductionDashboardService});
    const response=await app.inject({method:"GET",url:"/production-dashboard/analysis"});
    expect(response.statusCode).toBe(403);expect(analysis).not.toHaveBeenCalled();await app.close();
  });
  it("dispatches the static analysis route with trusted identity and no-store",async()=>{
    const app=Fastify(),analysis=vi.fn<(actor:unknown,input:unknown)=>Promise<{asOf:string}>>(async()=>({asOf:"test"}));
    registerProductionDashboardRoutes(app,{authenticate:async()=>({id:"stable-user",businessRoles:["production_management"],capabilities:["sourcing:view"]}) as unknown as AuthUser,service:{analysis} as unknown as ProductionDashboardService});
    const response=await app.inject({method:"GET",url:"/production-dashboard/analysis?page=2"});
    expect(response.statusCode).toBe(200);expect(response.headers["cache-control"]).toBe("no-store");
    expect(analysis.mock.calls[0]?.[0]).toMatchObject({actorId:"stable-user",actorRoles:["production_management"]});await app.close();
  });
});
