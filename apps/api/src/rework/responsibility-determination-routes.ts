/* eslint-disable @typescript-eslint/no-explicit-any */
import { ConfirmHighMultiplierSchema,CreateResponsibilityDraftSchema,FinalizeResponsibilitySchema,IdempotencyKeySchema,ResponsibilityDeterminationResponseSchema,TakeoverResponsibilitySchema,TransferResponsibilitySchema } from "@dx-rework/contracts";
import type { FastifyInstance,FastifyRequest } from "fastify";
import type { AuthUser } from "../auth/service.js";
import { ApplicationError } from "../platform/errors.js";
import type { TrustedActorContext } from "../tools/repositories.js";
import type { ResponsibilityDeterminationService } from "./responsibility-determination-service.js";
const token=(r:FastifyRequest)=>r.headers.cookie?.split(";").map(x=>x.trim()).find(x=>x.startsWith("dx_rework_session="))?.slice(18);
const parse=<T>(s:{safeParse(x:unknown):{success:true;data:T}|{success:false}},x:unknown):T=>{const r=s.safeParse(x);if(!r.success)throw new ApplicationError("VALIDATION_ERROR","Request validation failed",400);return r.data;};
const id=(x:unknown)=>parse({safeParse(v:unknown){return typeof v==="string"&&/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(v)?{success:true as const,data:v}:{success:false as const};}},x);
export type ResponsibilityDeterminationHttpDependencies=Readonly<{authenticate(v:string|undefined):Promise<AuthUser>;service:ResponsibilityDeterminationService}>;
export function registerResponsibilityDeterminationRoutes(app:FastifyInstance,d:ResponsibilityDeterminationHttpDependencies):void{
 const actor=async(r:FastifyRequest,cap:string):Promise<TrustedActorContext>=>{const u=await d.authenticate(token(r));if(!u.businessRoles?.length)throw new ApplicationError("NO_BUSINESS_ROLE","未分配业务角色",403);return{actorId:u.id,actorRoles:u.businessRoles,authorizationCapability:cap,authorizationCapabilities:u.capabilities,requestId:r.id};};
 const key=(r:FastifyRequest)=>parse(IdempotencyKeySchema,r.headers["idempotency-key"]);
 app.get("/rework-orders/:reworkOrderId/responsibility-determination",async r=>ResponsibilityDeterminationResponseSchema.parse(await d.service.get(await actor(r,"responsibility:determine"),id((r.params as any).reworkOrderId))));
 app.post("/rework-orders/:reworkOrderId/responsibility-determinations/drafts",async(r,reply)=>{const x=await d.service.saveDraft(await actor(r,"responsibility:determine"),id((r.params as any).reworkOrderId),parse(CreateResponsibilityDraftSchema,r.body),key(r));if(x.reused)reply.header("idempotency-replayed","true");return reply.code(201).send(ResponsibilityDeterminationResponseSchema.parse(x.value));});
 app.post("/rework-orders/:reworkOrderId/responsibility-determinations/finalize",async(r,reply)=>{const x=await d.service.finalize(await actor(r,"responsibility:determine"),id((r.params as any).reworkOrderId),parse(FinalizeResponsibilitySchema,r.body),key(r));if(x.reused)reply.header("idempotency-replayed","true");return ResponsibilityDeterminationResponseSchema.parse(x.value);});
 app.post("/rework-orders/:reworkOrderId/responsibility-determinations/transfer",async(r,reply)=>{const x=await d.service.transfer(await actor(r,"responsibility:determine"),id((r.params as any).reworkOrderId),parse(TransferResponsibilitySchema,r.body),key(r));if(x.reused)reply.header("idempotency-replayed","true");return ResponsibilityDeterminationResponseSchema.parse(x.value);});
 app.post("/rework-orders/:reworkOrderId/responsibility-determinations/takeover",async(r,reply)=>{const x=await d.service.takeover(await actor(r,"responsibility:takeover"),id((r.params as any).reworkOrderId),parse(TakeoverResponsibilitySchema,r.body),key(r));if(x.reused)reply.header("idempotency-replayed","true");return ResponsibilityDeterminationResponseSchema.parse(x.value);});
 app.post("/responsibility-determinations/:determinationId/high-multiplier-confirm",async(r,reply)=>{const x=await d.service.confirmHighMultiplier(await actor(r,"responsibility:confirm_high_multiplier"),id((r.params as any).determinationId),parse(ConfirmHighMultiplierSchema,r.body),key(r));if(x.reused)reply.header("idempotency-replayed","true");return ResponsibilityDeterminationResponseSchema.parse(x.value);});
}
