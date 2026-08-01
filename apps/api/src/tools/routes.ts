import type { FastifyInstance, FastifyRequest } from "fastify";
import { AttachmentParamsSchema, CreateExportJobSchema, CreateUploadIntentSchema, ExportJobParamsSchema } from "@dx-rework/contracts";
import type { AuthUser } from "../auth/service.js";
import { ApplicationError } from "../platform/errors.js";
import type { AttachmentService } from "./attachments.js";
import type { ExportJobService } from "./exports.js";
const cookieToken=(request:FastifyRequest):string|undefined=>request.headers.cookie?.split(";").map(v=>v.trim()).find(v=>v.startsWith("dx_rework_session="))?.slice("dx_rework_session=".length);
const parse=<T>(schema:{safeParse(value:unknown):{success:true;data:T}|{success:false}},value:unknown):T=>{const result=schema.safeParse(value);if(!result.success)throw new ApplicationError("VALIDATION_ERROR","Request validation failed",400);return result.data;};
export type ToolsHttpDependencies=Readonly<{authenticate(token:string|undefined):Promise<AuthUser>;attachments:AttachmentService;exports:ExportJobService}>;
export function registerToolsRoutes(app:FastifyInstance,deps:ToolsHttpDependencies):void{
 const actor=async(request:FastifyRequest)=>{const user=await deps.authenticate(cookieToken(request));if(!user.capabilities.includes("tools:user")){const missingRole=user.capabilities.length===0;throw new ApplicationError(missingRole?"NO_BUSINESS_ROLE":"FORBIDDEN",missingRole?"未分配业务权限":"无权使用公共 Tools",403);}return{actorId:user.id,actorRoles:user.businessRoles??[],authorizationCapability:"tools:user",requestId:request.id};};
 app.post("/tools/attachments/upload-intents",async(request,reply)=>reply.code(201).send(await deps.attachments.createUploadIntent(await actor(request),parse(CreateUploadIntentSchema,request.body))));
 app.post<{Params:{attachmentId:string}}>("/tools/attachments/:attachmentId/finalize",async(request)=>deps.attachments.finalize(await actor(request),parse(AttachmentParamsSchema,request.params).attachmentId));
 app.get<{Params:{attachmentId:string}}>("/tools/attachments/:attachmentId/download",async(request)=>{const trustedActor=await actor(request);return deps.attachments.createDownloadIntent(trustedActor.actorId,parse(AttachmentParamsSchema,request.params).attachmentId,async(binding)=>binding.entityType==="export_job"&&deps.exports.isOwnedBy(trustedActor.actorId,binding.entityId));});
 app.post("/tools/exports",async(request,reply)=>reply.code(201).send(await deps.exports.create(await actor(request),parse(CreateExportJobSchema,request.body))));
 app.get<{Params:{exportJobId:string}}>("/tools/exports/:exportJobId",async(request)=>deps.exports.query((await actor(request)).actorId,parse(ExportJobParamsSchema,request.params).exportJobId));
}
