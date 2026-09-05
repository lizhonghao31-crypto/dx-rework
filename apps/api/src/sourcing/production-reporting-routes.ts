import { z } from "zod";
import { ProductionReportingDetailSchema, ProductionReportingListSchema, ProductionScopeDirectorySchema,
  ProductionReportInputSchema, ProductionCorrectionInputSchema, ProductionExecutionInputSchema, ProductionScopeInputSchema } from "@dx-rework/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { businessActor } from "../access/business-authority.js";
import type { RootAuthority } from "../access/root-authority.js";
import type { AuthUser } from "../auth/service.js";
import { ApplicationError } from "../platform/errors.js";
import type { ProductionReportingService } from "./production-reporting-service.js";
const parse = <T>(schema:z.ZodType<T>,value:unknown):T => {
  const result=schema.safeParse(value);
  if(!result.success)throw new ApplicationError("VALIDATION_ERROR",result.error.issues[0]?.message??"输入无效",400);
  return result.data;
};
const Id=z.string().uuid();
const key=(request:FastifyRequest)=>parse(z.string().regex(/^[A-Za-z0-9._:-]{1,200}$/),request.headers["idempotency-key"]);
export function registerProductionReportingRoutes(app:FastifyInstance,dependencies:{
  authenticate(token:string|undefined):Promise<AuthUser>;root?:RootAuthority|undefined;service:ProductionReportingService;
}) {
  const actor=async(request:FastifyRequest)=>{
    const token=request.headers.cookie?.split(";").map(p=>p.trim()).find(p=>p.startsWith("dx_rework_session="))?.slice("dx_rework_session=".length);
    const user=await dependencies.authenticate(token);
    return businessActor(dependencies.root,user,request.id,"production-reporting");
  };
  const service=dependencies.service;
  app.get("/production-reporting",async request=>{
    const query=parse(z.object({page:z.coerce.number().int().min(1).max(100000).optional(),supplierId:Id.optional(),q:z.string().max(100).optional(),status:z.enum(["in_production","production_completed","shipped"]).optional()}).strict(),request.query);
    return ProductionReportingListSchema.parse(await service.list(await actor(request),query));
  });
  app.get("/production-reporting/scopes",async request=>ProductionScopeDirectorySchema.parse(await service.scopeDirectory(await actor(request))));
  app.post("/production-reporting/scopes",async request=>service.setScope(await actor(request),parse(ProductionScopeInputSchema,request.body),key(request)));
  app.get<{Params:{id:string}}>("/production-reporting/:id",async request=>ProductionReportingDetailSchema.parse(await service.detail(await actor(request),parse(Id,request.params.id))));
  app.post<{Params:{id:string}}>("/production-reporting/:id/reports",async request=>{
    const result=await service.report(await actor(request),parse(Id,request.params.id),parse(ProductionReportInputSchema,request.body),key(request));
    return ProductionReportingDetailSchema.parse(result.value);
  });
  app.post<{Params:{id:string;reportId:string}}>("/production-reporting/:id/reports/:reportId/corrections",async request=>{
    const result=await service.correct(await actor(request),parse(Id,request.params.id),parse(Id,request.params.reportId),parse(ProductionCorrectionInputSchema,request.body),key(request));
    return ProductionReportingDetailSchema.parse(result.value);
  });
  for(const kind of ["complete","ship"] as const)app.post<{Params:{id:string}}>(`/production-reporting/:id/${kind}`,async request=>{
    const result=await service.execute(await actor(request),parse(Id,request.params.id),kind,parse(ProductionExecutionInputSchema,request.body),key(request));
    return ProductionReportingDetailSchema.parse(result.value);
  });
}
