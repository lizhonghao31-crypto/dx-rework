import { isPmcOnly } from "@dx-rework/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { AttachmentParamsSchema, CreateExportJobSchema, CreateUploadIntentSchema, ExportJobParamsSchema } from "@dx-rework/contracts";
import { assertBusinessExportAllowed } from "../access/export-authority.js";
import type { AuthUser } from "../auth/service.js";
import { ApplicationError } from "../platform/errors.js";
import type { AttachmentService } from "./attachments.js";
import type { ExportJobService } from "./exports.js";
const cookieToken=(request:FastifyRequest):string|undefined=>request.headers.cookie?.split(";").map(v=>v.trim()).find(v=>v.startsWith("dx_rework_session="))?.slice("dx_rework_session=".length);
const parse=<T>(schema:{safeParse(value:unknown):{success:true;data:T}|{success:false}},value:unknown):T=>{const result=schema.safeParse(value);if(!result.success)throw new ApplicationError("VALIDATION_ERROR","Request validation failed",400);return result.data;};
const attachmentDeliveryMode=(request:FastifyRequest):"attachment"|"inline"|null=>{const mode=(request.query as {mode?:unknown}).mode;return mode==="preview"?"inline":mode==="download"?"attachment":null;};
export type ToolsHttpDependencies=Readonly<{
 authenticate(token:string|undefined):Promise<AuthUser>;
 isRootUser?(id:string):Promise<boolean>;
 attachments:AttachmentService;
 exports:ExportJobService;
 canDownloadBoundAttachment?(
   actor:Readonly<{actorId:string;actorRoles:readonly string[];capabilities:readonly string[]}>,
   binding:Readonly<{attachmentId:string;entityType:string;entityId:string;mimeType:string}>,
 ):Promise<boolean>;
}>;
export function registerToolsRoutes(app:FastifyInstance,deps:ToolsHttpDependencies):void{
 const actor=async(request:FastifyRequest,read=false)=>{const user=await deps.authenticate(cookieToken(request));const root=isPmcOnly(user.businessRoles??[]) && await deps.isRootUser?.(user.id)===true;const capability=read&&user.capabilities.includes("tools:read")?"tools:read":"tools:user";if((!read&&!root&&isPmcOnly(user.businessRoles??[]))||!user.capabilities.includes(capability)){const missingRole=user.capabilities.length===0;throw new ApplicationError(missingRole?"NO_BUSINESS_ROLE":"FORBIDDEN",missingRole?"未分配业务权限":"无权使用公共 Tools",403);}if(!user.businessRoles?.length)throw new ApplicationError("NO_BUSINESS_ROLE","未分配业务角色",403);return{user,trusted:{actorId:user.id,actorRoles:root?[...user.businessRoles,"root_superuser"]:user.businessRoles,authorizationCapability:capability,authorizationCapabilities:user.capabilities,requestId:request.id}};};
 app.post("/tools/attachments/upload-intents",async(request,reply)=>{const authenticated=await actor(request);return reply.code(201).send(await deps.attachments.createUploadIntent(authenticated.trusted,parse(CreateUploadIntentSchema,request.body)));});
 app.post<{Params:{attachmentId:string}}>("/tools/attachments/:attachmentId/finalize",async(request)=>{const authenticated=await actor(request);return deps.attachments.finalize(authenticated.trusted,parse(AttachmentParamsSchema,request.params).attachmentId);});
 app.get<{Params:{attachmentId:string}}>("/tools/attachments/:attachmentId/download",async(request,reply)=>{const authenticated=await actor(request,true);const trustedActor=authenticated.trusted;const disposition=attachmentDeliveryMode(request);const grant=await deps.attachments.createDownloadIntent(trustedActor,parse(AttachmentParamsSchema,request.params).attachmentId,async(binding)=>{if(binding.entityType==="export_job"){assertBusinessExportAllowed(trustedActor.actorRoles,"tools:export");return deps.exports.isOwnedBy(trustedActor.actorId,binding.entityId);}return await deps.canDownloadBoundAttachment?.({actorId:trustedActor.actorId,actorRoles:trustedActor.actorRoles,capabilities:authenticated.user.capabilities},{attachmentId:binding.attachmentId,entityType:binding.entityType,entityId:binding.entityId,mimeType:binding.mimeType})??false;},disposition??"attachment");return disposition?reply.redirect(grant.downloadUrl):grant;});
 app.post("/tools/exports",async(request,reply)=>{const authenticated=await actor(request,true);assertBusinessExportAllowed(authenticated.trusted.actorRoles,"tools:export");return reply.code(201).send(await deps.exports.create(authenticated.trusted,parse(CreateExportJobSchema,request.body)));});
 app.get<{Params:{exportJobId:string}}>("/tools/exports/:exportJobId",async(request)=>{const authenticated=await actor(request,true);assertBusinessExportAllowed(authenticated.trusted.actorRoles,"tools:export");return deps.exports.query(authenticated.trusted.actorId,parse(ExportJobParamsSchema,request.params).exportJobId);});
}
