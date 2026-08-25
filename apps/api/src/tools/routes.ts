import type { FastifyInstance, FastifyRequest } from "fastify";
import { AttachmentParamsSchema, CreateExportJobSchema, CreateUploadIntentSchema, ExportJobParamsSchema } from "@dx-rework/contracts";
import type { AuthUser } from "../auth/service.js";
import { ApplicationError } from "../platform/errors.js";
import type { AttachmentService } from "./attachments.js";
import type { ExportJobService } from "./exports.js";
const cookieToken=(request:FastifyRequest):string|undefined=>request.headers.cookie?.split(";").map(v=>v.trim()).find(v=>v.startsWith("dx_rework_session="))?.slice("dx_rework_session=".length);
const parse=<T>(schema:{safeParse(value:unknown):{success:true;data:T}|{success:false}},value:unknown):T=>{const result=schema.safeParse(value);if(!result.success)throw new ApplicationError("VALIDATION_ERROR","Request validation failed",400);return result.data;};
const attachmentDeliveryMode=(request:FastifyRequest):"attachment"|"inline"|null=>{const mode=(request.query as {mode?:unknown}).mode;return mode==="preview"?"inline":mode==="download"?"attachment":null;};
export type ToolsHttpDependencies=Readonly<{
 authenticate(token:string|undefined):Promise<AuthUser>;
 attachments:AttachmentService;
 exports:ExportJobService;
 canDownloadBoundAttachment?(
   actor:Readonly<{actorId:string;actorRoles:readonly string[];capabilities:readonly string[]}>,
   binding:Readonly<{entityType:string;entityId:string;mimeType:string}>,
 ):Promise<boolean>;
}>;
export function registerToolsRoutes(app:FastifyInstance,deps:ToolsHttpDependencies):void{
 const actor=async(request:FastifyRequest)=>{const user=await deps.authenticate(cookieToken(request));if(!user.capabilities.includes("tools:user")){const missingRole=user.capabilities.length===0;throw new ApplicationError(missingRole?"NO_BUSINESS_ROLE":"FORBIDDEN",missingRole?"未分配业务权限":"无权使用公共 Tools",403);}if(!user.businessRoles?.length)throw new ApplicationError("NO_BUSINESS_ROLE","未分配业务角色",403);return{user,trusted:{actorId:user.id,actorRoles:user.businessRoles,authorizationCapability:"tools:user",requestId:request.id}};};
 app.post("/tools/attachments/upload-intents",async(request,reply)=>{const authenticated=await actor(request);return reply.code(201).send(await deps.attachments.createUploadIntent(authenticated.trusted,parse(CreateUploadIntentSchema,request.body)));});
 app.post<{Params:{attachmentId:string}}>("/tools/attachments/:attachmentId/finalize",async(request)=>{const authenticated=await actor(request);return deps.attachments.finalize(authenticated.trusted,parse(AttachmentParamsSchema,request.params).attachmentId);});
 app.get<{Params:{attachmentId:string}}>("/tools/attachments/:attachmentId/download",async(request,reply)=>{const authenticated=await actor(request);const trustedActor=authenticated.trusted;const disposition=attachmentDeliveryMode(request);const grant=await deps.attachments.createDownloadIntent(trustedActor,parse(AttachmentParamsSchema,request.params).attachmentId,async(binding)=>(binding.entityType==="export_job"&&await deps.exports.isOwnedBy(trustedActor.actorId,binding.entityId))||(await deps.canDownloadBoundAttachment?.({actorId:trustedActor.actorId,actorRoles:trustedActor.actorRoles,capabilities:authenticated.user.capabilities},{entityType:binding.entityType,entityId:binding.entityId,mimeType:binding.mimeType})??false),disposition??"attachment");return disposition?reply.redirect(grant.downloadUrl):grant;});
 app.post("/tools/exports",async(request,reply)=>{const authenticated=await actor(request);return reply.code(201).send(await deps.exports.create(authenticated.trusted,parse(CreateExportJobSchema,request.body)));});
 app.get<{Params:{exportJobId:string}}>("/tools/exports/:exportJobId",async(request)=>{const authenticated=await actor(request);return deps.exports.query(authenticated.trusted.actorId,parse(ExportJobParamsSchema,request.params).exportJobId);});
}
