import {QualityNativeTaskQuerySchema,WarehouseNativeTaskQuerySchema} from '@dx-rework/contracts/production-readiness';
import {SettingsCalculationSchema,SettingsSetSaveSchema,SettingsSetDraftSchema,SettingsSetBasisSchema,SettingsSetPublishSchema,SettingsSetRestoreSchema} from '@dx-rework/contracts/sla-settings-sets';
import {SpecialCraftSaveSchema} from '@dx-rework/contracts/digital-craft';
import {OrderTimeCalculationSchema,OrderTimeSettingsSaveSchema,OrderTimeSettingsUseSchema} from '@dx-rework/contracts/order-time-settings';
import {orderTimeSettingsCalculation} from './order-time-settings-calculation.js';
import {settingsCalculation} from './sla-settings-calculation.js';
import {SlaDraftGroupSchema,SlaDraftSaveSchema,SlaDraftDiscardSchema} from '@dx-rework/contracts/sla-settings-drafts';
import {SlaHistoryQuerySchema,SlaCopyVersionSchema,SlaApplicationCandidatesQuerySchema} from '@dx-rework/contracts/sla-settings-history';
import {DigitalSlaValuesSchema,DIGITAL_SLA_PARAMETERS} from '@dx-rework/contracts/digital-sla';
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { DigitalTaskCompleteSchema, DigitalTaskAssignmentSchema, DigitalDeadlinePolicySchema, DigitalTimeCorrectionSchema } from "@dx-rework/contracts/digital-production-tasks";
import { businessActor } from "../access/business-authority.js";
import { ApplicationError } from "../platform/errors.js";
import type { DigitalIdentityDependencies } from "./identity-routes.js";
import type { DigitalProductionTaskService } from "./task-service.js";
export function registerDigitalTaskRoutes(app: FastifyInstance, dependencies: DigitalIdentityDependencies, service: DigitalProductionTaskService) {
  const actor = async (request: FastifyRequest) => {
    const token = request.headers.cookie?.split(";").map(value => value.trim()).find(value => value.startsWith("dx_rework_session="))?.slice(18);
    return businessActor(dependencies.root, await dependencies.authenticate(token), request.id, "digital_production:tasks");
  };
  const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
    const result = schema.safeParse(value); if (!result.success) throw new ApplicationError("VALIDATION_ERROR", "请检查任务、时间或时效参数", 400); return result.data;
  };
  const key = (request: FastifyRequest) => typeof request.headers["idempotency-key"] === "string" ? request.headers["idempotency-key"] : "";
  const id = (request: FastifyRequest) => parse(z.string().uuid(), (request.params as Record<string, unknown>).taskId);
  app.get("/digital-production/document-directory/:kind/:id",async request=>{
    const params=parse(z.object({kind:z.enum(['source','order']),id:z.string().uuid()}).strict(),request.params);
    return service.resourceDocuments(await actor(request),params.kind,params.id);
  });
  app.post("/digital-production/tasks/:taskId/priority", async request => service.prioritize(await actor(request), id(request), parse(z.object({ priority: z.enum(["normal", "urgent"]) }).strict(), request.body).priority, key(request)));
  app.get("/digital-production/tasks", async request => service.list(await actor(request), parse(z.object({ page: z.coerce.number().int().min(1).max(100000).default(1) }).strict(), request.query).page));
  if(dependencies.workbenchNumberedCreation)app.get("/digital-production/warehouse/native-tasks",async(request,reply)=>{
    const trusted=await actor(request),input=parse(WarehouseNativeTaskQuerySchema,request.query);
    reply.header('cache-control','private, no-store');
    return service.list(trusted,input.page,input);
  });
  if(dependencies.workbenchNumberedCreation)app.get("/digital-production/quality/native-tasks",async(request,reply)=>{
    const trusted=await actor(request),input=parse(QualityNativeTaskQuerySchema,request.query);
    reply.header('cache-control','private, no-store');
    return service.list(trusted,input.page,input);
  });
  app.get("/digital-production/tasks/:taskId", async request => service.readWorkItem(await actor(request), id(request)));
  app.get("/digital-production/tasks/:taskId/documents", async request => service.documents(await actor(request), id(request)));
  app.get("/digital-production/tasks/:taskId/history", async request => service.history(await actor(request), id(request)));
  app.post("/digital-production/tasks/:taskId/complete", async request => service.complete(await actor(request), id(request), parse(DigitalTaskCompleteSchema, request.body), key(request)));
  app.post("/digital-production/tasks/:taskId/handover", async request => service.handover(await actor(request), id(request), parse(DigitalTaskCompleteSchema, request.body), key(request)));
  app.post("/digital-production/tasks/:taskId/feedback", async request => {
    const input = parse(z.object({ reason: z.string().trim().min(1).max(1000), blocked: z.boolean() }).strict(), request.body);
    return service.feedback(await actor(request), id(request), input.reason, input.blocked, key(request));
  });
  app.post("/digital-production/tasks/:taskId/reassign", async request => service.reassign(await actor(request), id(request), parse(DigitalTaskAssignmentSchema, request.body).assigneeId, key(request)));
  app.post("/digital-production/tasks/:taskId/time-corrections", async request => service.correctTime(await actor(request), id(request), parse(DigitalTimeCorrectionSchema, request.body), key(request)));
  const standardDraft=z.object({expectedVersion:z.number().int().nonnegative(),values:DigitalSlaValuesSchema,reason:z.string().trim().min(1).max(1000)}).strict();
  const orderSelection=z.object({orderId:z.string().uuid(),configurationVersion:z.number().int().positive(),parameterKeys:z.array(z.string()).min(1).max(DIGITAL_SLA_PARAMETERS.length),reason:z.string().trim().min(1).max(1000)}).strict();
  const sets='/digital-production/sla-settings/sets';
  const timeSettings='/digital-production/order-time-settings';
  const crafts='/digital-production/special-craft-library';
  app.get(crafts+'/choices',async request=>service.specialCraftLibrary().choices(await actor(request)));
  app.get(crafts,async request=>service.specialCraftLibrary().list(await actor(request)));
  app.get(crafts+'/:id/history',async request=>service.specialCraftLibrary().history(await actor(request),parse(z.string().uuid(),(request.params as Record<string,unknown>).id)));
  app.post(crafts,async request=>service.specialCraftLibrary().save(await actor(request),parse(SpecialCraftSaveSchema,request.body),key(request)));
  app.get(timeSettings,async request=>service.orderTimeSettings().read(await actor(request)));
  app.get(timeSettings+'/history',async request=>service.orderTimeSettings().history(await actor(request),parse(z.object({page:z.coerce.number().int().positive().max(100000).default(1)}).strict(),request.query).page));
  app.post(timeSettings+'/save',async request=>service.orderTimeSettings().save(await actor(request),parse(OrderTimeSettingsSaveSchema,request.body),key(request)));
  app.post(timeSettings+'/use',async request=>service.orderTimeSettings().use(await actor(request),parse(OrderTimeSettingsUseSchema,request.body),key(request)));
  app.post(timeSettings+'/remove',async request=>service.orderTimeSettings().remove(await actor(request),parse(OrderTimeSettingsUseSchema,request.body),key(request)));
  app.post(timeSettings+'/calculate',async request=>{await service.orderTimeSettings().read(await actor(request));try{return orderTimeSettingsCalculation(parse(OrderTimeCalculationSchema,request.body));}catch(error){if(error instanceof ApplicationError)throw error;throw new ApplicationError('VALIDATION_ERROR',error instanceof Error?error.message:'请核对本次演算条件',400);}});
  app.post(sets+'/calculate',async request=>{await service.settingsSets().read(await actor(request));try{return settingsCalculation(parse(SettingsCalculationSchema,request.body));}catch(e){if(e instanceof ApplicationError)throw e;throw new ApplicationError('VALIDATION_ERROR',e instanceof Error?e.message:'请检查本次演算条件',400);}});
  app.get(sets,async request=>service.settingsSets().read(await actor(request)));
  app.get(sets+'/history',async request=>service.settingsSets().history(await actor(request),parse(z.object({page:z.coerce.number().int().positive().max(100000).default(1)}).strict(),request.query).page));
  app.get(sets+'/history/values',async request=>service.settingsSets().historyValues(await actor(request),parse(z.object({setId:z.uuid().nullable().default(null),unifiedSourceVersion:z.coerce.number().int().positive().nullable().default(null)}).strict(),request.query)));
  app.post(sets+'/draft',async request=>service.settingsSets().save(await actor(request),parse(SettingsSetSaveSchema,request.body),parse(z.uuid(),key(request))));
  app.post(sets+'/discard',async request=>service.settingsSets().discard(await actor(request),parse(SettingsSetBasisSchema,request.body),parse(z.uuid(),key(request))));
  app.post(sets+'/restore',async request=>service.settingsSets().restore(await actor(request),parse(SettingsSetRestoreSchema,request.body),parse(z.uuid(),key(request))));
  app.post(sets+'/preview',async request=>service.settingsSets().preview(await actor(request),parse(SettingsSetDraftSchema,request.body)));
  app.post(sets+'/publish',async request=>service.settingsSets().publish(await actor(request),parse(SettingsSetPublishSchema,request.body),parse(z.uuid(),key(request))));
  app.get('/digital-production/sla-settings/orders/candidates',async request=>service.slaApplicationCandidates(await actor(request),parse(SlaApplicationCandidatesQuerySchema,request.query)));
  app.post('/digital-production/sla-settings/orders/preview',async request=>service.previewSlaOrder(await actor(request),parse(orderSelection,request.body)));
  app.post('/digital-production/sla-settings/orders/apply',async request=>service.applySlaOrder(await actor(request),parse(orderSelection.extend({previewToken:z.string().max(512).regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/)}),request.body),parse(z.string().uuid(),key(request))));
  app.get('/digital-production/sla-settings/drafts',async request=>service.readSlaDraft(await actor(request),parse(z.object({group:SlaDraftGroupSchema}).strict(),request.query).group));
  app.post('/digital-production/sla-settings/drafts',async request=>service.saveSlaDraft(await actor(request),parse(SlaDraftSaveSchema,request.body),parse(z.string().uuid(),key(request))));
  app.post('/digital-production/sla-settings/drafts/discard',async request=>service.discardSlaDraft(await actor(request),parse(SlaDraftDiscardSchema,request.body),parse(z.string().uuid(),key(request))));
  app.post('/digital-production/sla-settings/drafts/copy-version',async request=>service.copySlaVersion(await actor(request),parse(SlaCopyVersionSchema,request.body),parse(z.string().uuid(),key(request))));
  app.get('/digital-production/sla-settings/history',async request=>service.slaHistory(await actor(request),parse(SlaHistoryQuerySchema,request.query)));
  app.get('/digital-production/sla-settings/history/:version',async request=>service.slaHistoryVersion(await actor(request),parse(z.coerce.number().int().positive(),(request.params as Record<string,unknown>).version)));
  app.get('/digital-production/sla-settings',async request=>service.slaSettings(await actor(request),parse(z.object({version:z.coerce.number().int().positive().optional()}).strict(),request.query).version));
  app.post('/digital-production/sla-settings/calculation-preview',async request=>service.slaCalculationPreview(await actor(request),request.body));
  app.post('/digital-production/sla-settings/preview',async request=>service.previewSlaSettings(await actor(request),parse(standardDraft,request.body)));
  app.post('/digital-production/sla-settings/publish',async request=>service.publishSlaSettings(await actor(request),parse(standardDraft.extend({savedDraftRevision:z.number().int().positive().optional(),previewToken:z.string().max(512).regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/)}),request.body),parse(z.string().uuid(),key(request))));
  app.get("/digital-production/deadline-policies", async request => service.policies(await actor(request)));
  app.put("/digital-production/deadline-policies/:nodeKey", async request => service.changePolicy(await actor(request), parse(z.string().regex(/^[a-z][a-z_]{1,99}$/), (request.params as Record<string, unknown>).nodeKey), parse(DigitalDeadlinePolicySchema, request.body), key(request)));
  app.post("/digital-production/lifecycle/:kind/:resourceId", async request => {
    const params = parse(z.object({ kind: z.enum(["order", "source"]), resourceId: z.string().uuid() }).strict(), request.params);
    const input = parse(z.object({ action: z.enum(["pause", "resume", "cancel"]), reason: z.string().trim().min(1).max(1000) }).strict(), request.body);
    return service.controlResource(await actor(request), { kind: params.kind, id: params.resourceId }, input.action, input.reason, key(request));
  });
}
