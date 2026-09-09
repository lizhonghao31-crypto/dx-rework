import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { ProductionDashboardQuerySchema } from "@dx-rework/contracts";
import { businessActor } from "../access/business-authority.js";
import type { RootAuthority } from "../access/root-authority.js";
import type { AuthUser } from "../auth/service.js";
import { ApplicationError } from "../platform/errors.js";
import type { ProductionDashboardService } from "./production-dashboard-service.js";

export function registerProductionDashboardRoutes(app:FastifyInstance,dependencies:{
  authenticate(token:string|undefined):Promise<AuthUser>;root?:RootAuthority|undefined;service:ProductionDashboardService;
}) {
  const actor=async(request:FastifyRequest)=>{
    const token=request.headers.cookie?.split(";").map(p=>p.trim()).find(p=>p.startsWith("dx_rework_session="))?.slice("dx_rework_session=".length);
    return businessActor(dependencies.root,await dependencies.authenticate(token),request.id,"production-reporting");
  };
  app.get("/production-dashboard/analysis",async(request,reply)=>{
    const trusted=await actor(request);
    reply.header("Cache-Control","no-store");
    return dependencies.service.analysis(trusted,request.query);
  });
  app.get("/production-dashboard",async request=>{
    const query=ProductionDashboardQuerySchema.safeParse(request.query);
    if(!query.success)throw new ApplicationError("VALIDATION_ERROR","看板筛选信息无效",400);
    return dependencies.service.list(await actor(request),query.data);
  });
  app.get<{Params:{id:string}}>("/production-dashboard/:id",async request=>{
    const id=z.string().uuid().safeParse(request.params.id);
    if(!id.success)throw new ApplicationError("VALIDATION_ERROR","生产订单编号无效",400);
    return dependencies.service.detail(await actor(request),id.data);
  });
}
