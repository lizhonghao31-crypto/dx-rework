import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AuthUser } from "../auth/service.js";
import type { RootAuthority } from "../access/root-authority.js";
import { businessActor } from "../access/business-authority.js";
import type { ProductionClosureService } from "./production-closure-service.js";
export function registerProductionClosureRoutes(app:FastifyInstance,dependencies:{authenticate(token:string|undefined):Promise<AuthUser>;root?:RootAuthority|undefined;service:ProductionClosureService}) {
 const actor=async(request:FastifyRequest,capability:string)=>{
  const token=request.headers.cookie?.split(";").map(p=>p.trim()).find(p=>p.startsWith("dx_rework_session="))?.slice("dx_rework_session=".length);
  return businessActor(dependencies.root,await dependencies.authenticate(token),request.id,capability);
 };
 app.get("/production-closure/pilots",async request=>dependencies.service.pilots(await actor(request,"sourcing:view")));
 app.put("/production-closure/pilots",async request=>dependencies.service.setPilot(await actor(request,"sourcing:view"),request.body));
 app.post<{Params:{id:string}}>("/production-closure/alerts/:id/read",async request=>dependencies.service.markRead(await actor(request,"todo:view"),request.params.id));
 app.get<{Querystring:{q?:string;page?:string;cuttingOrderId?:string}}>("/production-closure/expected-receipts",async request=>dependencies.service.expected(await actor(request,"receiving:create"),{q:request.query.q,page:request.query.page===undefined?1:Number(request.query.page),cuttingOrderId:request.query.cuttingOrderId}));
 app.get<{Params:{id:string};Querystring:{factoryDecisionId?:string}}>("/production-closure/orders/:id/receipts",async request=>dependencies.service.receiptSummary(await actor(request,"production-reporting"),request.params.id,request.query.factoryDecisionId??null));
}
