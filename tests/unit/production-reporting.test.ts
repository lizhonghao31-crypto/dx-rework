import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { ProductionReportInputSchema, ProductionCorrectionInputSchema, ProductionExecutionInputSchema } from "@dx-rework/contracts";
import { ProductionReportingService } from "../../apps/api/src/sourcing/production-reporting-service.js";
import { registerProductionReportingRoutes } from "../../apps/api/src/sourcing/production-reporting-routes.js";
import { accessiblePlatformModules, canAccessProduction, platformLandingTarget, platformModuleHref } from "../../apps/web/src/platform-modules.js";
const actor=(role:string,cap="production-reporting")=>({actorId:randomUUID(),actorRoles:[role],authorizationCapability:cap,authorizationCapabilities:[cap],requestId:randomUUID()});
const date=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
const input={position:1,businessDate:date,quantity:1};
describe("SSP-07 reporting boundaries",()=>{
  it("accepts integer increments and explicit corrections without finance or price fields",()=>{
    expect(ProductionReportInputSchema.safeParse(input).success).toBe(true);
    for(const extra of [{quantity:0},{quantity:-1},{quantity:1.5},{position:21},{businessDate:"2026-02-30"},{financeMatched:true},{daxingUnitPrice:"88"}])
      expect(ProductionReportInputSchema.safeParse({...input,...extra}).success).toBe(false);
    expect(ProductionCorrectionInputSchema.safeParse({expectedReportId:randomUUID(),businessDate:date,quantity:0,reason:"撤销误报"}).success).toBe(true);
    expect(ProductionCorrectionInputSchema.safeParse({expectedReportId:randomUUID(),businessDate:date,quantity:0,reason:"  "}).success).toBe(false);
    expect(ProductionExecutionInputSchema.safeParse({businessDate:date,confirmed:false}).success).toBe(false);
  });
  it.each(["order_merchandiser","worker","warehouse_keeper","ie_reviewer","factory_payables","owner_group","production_management"])("does not grant normal writes to %s through a capability alone",async role=>{
    const connect=vi.fn(),service=new ProductionReportingService({connect} as unknown as Pool),user=actor(role),id=randomUUID();
    await expect(service.report(user,id,input,randomUUID())).rejects.toMatchObject({statusCode:403});
    await expect(service.execute(user,id,"complete",{businessDate:date,confirmed:true},randomUUID())).rejects.toMatchObject({statusCode:403});
    await expect(service.correct(user,id,randomUUID(),{expectedReportId:randomUUID(),businessDate:date,quantity:0,reason:"修正"},randomUUID())).rejects.toMatchObject({statusCode:403});
    expect(connect).not.toHaveBeenCalled();
  });
  it("requires dedicated role and capability and enters the production dashboard",()=>{
    const user={id:randomUUID(),displayName:"驻厂",businessRoles:["production_reporter"],capabilities:["production-reporting"]};
    expect(canAccessProduction(user)).toBe(true);expect(platformLandingTarget(user)).toBe("ui/production-dashboard");
    const module=accessiblePlatformModules(user).find(item=>item.id==="production")!;
    expect(platformModuleHref(module)).toBe("ui/production-dashboard");
    expect(canAccessProduction({...user,capabilities:[]})).toBe(false);
    expect(canAccessProduction({...user,businessRoles:["worker"]})).toBe(false);
  });
  it("enforces server role rejection when an unauthorized employee calls HTTP directly",async()=>{
    const connect=vi.fn();const app=Fastify();
    registerProductionReportingRoutes(app,{authenticate:async()=>({id:randomUUID(),displayName:"跟单",businessRoles:["order_merchandiser"],capabilities:["sourcing:view","production-reporting"]}),service:new ProductionReportingService({connect} as unknown as Pool)});
    try{const result=await app.inject({method:"POST",url:`/production-reporting/${randomUUID()}/reports`,headers:{"idempotency-key":randomUUID()},payload:input});expect(result.statusCode).toBe(403);expect(connect).not.toHaveBeenCalled();}finally{await app.close();}
  });
});
