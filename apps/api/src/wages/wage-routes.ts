import { IdempotencyKeySchema } from "@dx-rework/contracts";
import { AdministrativeReturnSchema, CreateWageAdjustmentSchema, DecideWageAdjustmentSchema, ExpectedWagePeriodVersionSchema, LockWagePeriodSchema, RejectWageAdjustmentSchema, WageAdjustmentParamsSchema, WageItemParamsSchema, WagePeriodParamsSchema } from "@dx-rework/contracts/wages";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { businessActor } from "../access/business-authority.js";
import type { RootAuthority } from "../access/root-authority.js";
import type { AuthUser } from "../auth/service.js";
import { ApplicationError } from "../platform/errors.js";
import type { TrustedActorContext } from "../tools/repositories.js";
import type { WageService } from "./wage-service.js";
import type { WageExportService } from "./wage-export-service.js";

const token=(r:FastifyRequest)=>r.headers.cookie?.split(";").map(x=>x.trim()).find(x=>x.startsWith("dx_rework_session="))?.slice(18);
const parse=<T>(s:{safeParse(v:unknown):{success:true;data:T}|{success:false}},v:unknown):T=>{const r=s.safeParse(v);if(!r.success)throw new ApplicationError("VALIDATION_ERROR","Request validation failed",400);return r.data};
export type WageHttpDependencies=Readonly<{authenticate(v:string|undefined):Promise<AuthUser>;service:WageService;exportService:WageExportService;root:RootAuthority}>;
export function registerWageRoutes(app:FastifyInstance,d:WageHttpDependencies):void{
 const actingRole=(cap:string):string|undefined=>cap==="wage:tail_review"||cap==="wage:adjustment_request"?"tail_supervisor":cap==="wage:administrative_review"||cap==="wage:adjustment_approve"?"administrative_clerk":cap==="wage:month_close"?"wage_month_close_accountant":cap==="wage:export"?"finance_read":undefined;
 const actor=async(r:FastifyRequest,cap:string):Promise<TrustedActorContext>=>businessActor(d.root,await d.authenticate(token(r)),r.id,cap,actingRole(cap));
 const key=(r:FastifyRequest)=>parse(IdempotencyKeySchema,r.headers["idempotency-key"]);
 const replay=(reply:{header(k:string,v:string):unknown},reused:boolean)=>{if(reused)reply.header("idempotency-replayed","true")};
 app.get("/wage-periods",async r=>d.service.list(await actor(r,"wage:view")));
 app.get("/wage-periods/:periodId",async r=>d.service.get(await actor(r,"wage:view"),parse(WagePeriodParamsSchema,r.params).periodId));
 app.get("/wage-periods/:periodId/items",async r=>(await d.service.get(await actor(r,"wage:view"),parse(WagePeriodParamsSchema,r.params).periodId)).items);
 app.get("/wage-items/:wageItemId",async r=>d.service.item(await actor(r,"wage:view"),parse(WageItemParamsSchema,r.params).wageItemId));
 app.post("/wage-periods/:periodId/tail-approve",async(r,reply)=>{const p=parse(WagePeriodParamsSchema,r.params),b=parse(ExpectedWagePeriodVersionSchema,r.body),x=await d.service.review(await actor(r,"wage:tail_review"),p.periodId,b.expectedVersion,"tail",null,key(r));replay(reply,x.reused);return x.value});
 app.post("/wage-periods/:periodId/administrative-approve",async(r,reply)=>{const p=parse(WagePeriodParamsSchema,r.params),b=parse(ExpectedWagePeriodVersionSchema,r.body),x=await d.service.review(await actor(r,"wage:administrative_review"),p.periodId,b.expectedVersion,"administrative_approve",null,key(r));replay(reply,x.reused);return x.value});
 app.post("/wage-periods/:periodId/administrative-return",async(r,reply)=>{const p=parse(WagePeriodParamsSchema,r.params),b=parse(AdministrativeReturnSchema,r.body),x=await d.service.review(await actor(r,"wage:administrative_review"),p.periodId,b.expectedVersion,"administrative_return",b.reason,key(r));replay(reply,x.reused);return x.value});
 app.post("/wage-adjustments",async(r,reply)=>{const x=await d.service.requestAdjustment(await actor(r,"wage:adjustment_request"),parse(CreateWageAdjustmentSchema,r.body),key(r));replay(reply,x.reused);return reply.code(201).send(x.value)});
 app.post("/wage-adjustments/:adjustmentId/approve",async(r,reply)=>{const p=parse(WageAdjustmentParamsSchema,r.params),b=parse(DecideWageAdjustmentSchema,r.body),x=await d.service.decideAdjustment(await actor(r,"wage:adjustment_approve"),p.adjustmentId,b.expectedVersion,true,b.reason,key(r));replay(reply,x.reused);return x.value});
 app.post("/wage-adjustments/:adjustmentId/reject",async(r,reply)=>{const p=parse(WageAdjustmentParamsSchema,r.params),b=parse(RejectWageAdjustmentSchema,r.body),x=await d.service.decideAdjustment(await actor(r,"wage:adjustment_approve"),p.adjustmentId,b.expectedVersion,false,b.reason,key(r));replay(reply,x.reused);return x.value});
 app.post("/wage-periods/:periodId/lock",async(r,reply)=>{const p=parse(WagePeriodParamsSchema,r.params),b=parse(LockWagePeriodSchema,r.body),x=await d.service.lock(await actor(r,"wage:month_close"),p.periodId,b.expectedVersion,b.lockNote,key(r));replay(reply,x.reused);return x.value});
 app.get("/wage-periods/:periodId/export.xlsx",async(r,reply)=>{const p=parse(WagePeriodParamsSchema,r.params);const x=await d.exportService.export(await actor(r,"wage:export"),p.periodId);return reply.header("content-type","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet").header("content-disposition",`attachment; filename*=UTF-8''${encodeURIComponent(x.filename)}`).send(x.content)});
}
