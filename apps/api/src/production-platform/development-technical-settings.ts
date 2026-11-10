import {appendCurrentSettingsSet,lockSettingsStandards,settingsPublicationBasis} from './sla-settings-set-repository.js';
import {createHash} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {DevelopmentCycleDraftSchema,DevelopmentCyclePublishSchema,DevelopmentCycleValuesSchema,SaveTechnicalTemplateSchema,technicalSizeTableIssues} from '@dx-rework/contracts/digital-development-technical';
import type {TrustedActorContext} from '../tools/repositories.js';
import {isRootActor} from '../access/business-authority.js';
import {businessNow} from '../acceptance-clock/business-time.js';
import {ApplicationError} from '../platform/errors.js';
import {assertSlaSettingsActor,assertSlaSettingsReadActor} from './sla-settings-authority.js';
import {assertSavedSettingsDraft,consumeSavedSettingsDraft} from './sla-settings-drafts.js';
import {DigitalProductionAccessPolicy,digitalForbidden,digitalNotFound} from './access-policy.js';
import {SlaPreviewTokens} from './sla-preview-token.js';
const conflict=(message:string):never=>{throw new ApplicationError('DEVELOPMENT_TECHNICAL_CONFLICT',message,409);};
type CycleDraft=ReturnType<typeof DevelopmentCycleDraftSchema.parse>;
const fingerprint=(actorId:string,d:CycleDraft,basis:Awaited<ReturnType<typeof settingsPublicationBasis>>)=>createHash('sha256').update(JSON.stringify(['development-cycle',actorId,d.expectedVersion,d.values.normalDays,d.values.urgentDays,d.values.sizeReviewHours,d.values.externalWashDays,d.reason,basis])).digest('hex');

/** A scoped extension of the existing settings; old global SLA catalogs are never reinterpreted. */
export class DevelopmentTechnicalSettingsService{
 private readonly tokens:SlaPreviewTokens;
 constructor(private readonly database:Pool,private readonly enabled:boolean,secret?:string){this.tokens=new SlaPreviewTokens(secret);}
 private async transaction<T>(work:(db:PoolClient)=>Promise<T>,write=false){const db=await this.database.connect();try{await db.query(write?'BEGIN':'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');if(write)await db.query("SELECT pg_advisory_xact_lock(hashtextextended('digital-production-task-lifecycle-v1',0))");const result=await work(db);await db.query('COMMIT');return result;}catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}}
 private async current(db:PoolClient,version?:number){
  if(!(await db.query("SELECT to_regclass('digital_development_cycle_standards') AS relation")).rows[0]?.relation)digitalNotFound();
  const row=(await db.query('SELECT * FROM digital_development_cycle_standards WHERE ($1::integer IS NULL OR version=$1) ORDER BY version DESC LIMIT 1',[version??null])).rows[0]??digitalNotFound();
  return {version:row.version as number,values:DevelopmentCycleValuesSchema.parse(row.values_json),scope:'new_sources' as const};
 }
 async read(actor:TrustedActorContext,version?:number){return this.transaction(async db=>{await assertSlaSettingsReadActor(db,actor);return {...await this.current(db,version),history:(await db.query('SELECT version,reason FROM digital_development_cycle_standards ORDER BY version DESC LIMIT 30')).rows};});}
 async preview(actor:TrustedActorContext,raw:unknown){const input=DevelopmentCycleDraftSchema.parse(raw);return this.transaction(async db=>{
  await assertSlaSettingsActor(db,actor);const current=await this.current(db);if(current.version!==input.expectedVersion)conflict('现行开发周期已更新，请重新读取');
  const changes=(Object.keys(input.values) as Array<keyof typeof input.values>).filter(key=>input.values[key]!==current.values[key]).map(key=>({key,before:current.values[key],after:input.values[key]}));
  if(!changes.length)conflict('没有需要发布的开发周期变化');
  return {token:this.tokens.issue(fingerprint(actor.actorId,input,await settingsPublicationBasis(db))),version:current.version,scope:'new_sources' as const,existingSourcesChanged:0,changes};
 });}
 async publish(actor:TrustedActorContext,raw:unknown,key:string){const input=DevelopmentCyclePublishSchema.parse(raw);if(!this.enabled)digitalForbidden();if(!/^[A-Za-z0-9._:-]{1,128}$/.test(key))conflict('缺少操作标识');return this.transaction(async db=>{
  await assertSlaSettingsActor(db,actor,true);const command='development-cycle-standard',hash=createHash('sha256').update(JSON.stringify(input)).digest('hex');
  const prior=(await db.query('SELECT payload_hash,response FROM digital_production_commands WHERE actor_id=$1 AND command=$2 AND key=$3',[actor.actorId,command,key])).rows[0];
  if(prior){if(prior.payload_hash!==hash)conflict('原发布标识不能用于不同内容');return prior.response;}
  await lockSettingsStandards(db);
  const current=await this.current(db);if(current.version!==input.expectedVersion)conflict('现行开发周期已更新，请重新预览');
  this.tokens.verify(input.previewToken,fingerprint(actor.actorId,input,await settingsPublicationBasis(db)));
  if(input.savedDraftRevision!==undefined)await assertSavedSettingsDraft(db,actor,'development',input.savedDraftRevision,input);
  if(JSON.stringify(current.values)===JSON.stringify(input.values))conflict('没有参数变化');
  const version=current.version+1;
  await db.query('INSERT INTO digital_development_cycle_standards(version,values_json,changed_by,reason) VALUES($1,$2,$3,$4)',[version,JSON.stringify(input.values),actor.actorId,input.reason]);
  // This original endpoint accepts text keys, whereas the immutable pair's
  // request_key is UUID. Bind a stable internal key to this actor/command,
  // preserving the original public key and command receipt unchanged.
  const pairDigest=createHash('sha256').update(JSON.stringify(['development-cycle-pair-v1',actor.actorId,key])).digest('hex');
  const pairKey=`${pairDigest.slice(0,8)}-${pairDigest.slice(8,12)}-5${pairDigest.slice(13,16)}-8${pairDigest.slice(17,20)}-${pairDigest.slice(20,32)}`;
  await appendCurrentSettingsSet(db,actor.actorId,pairKey);
  const result={version,scope:'new_sources' as const,existingSourcesChanged:0};
  if(input.savedDraftRevision!==undefined)await consumeSavedSettingsDraft(db,actor,'development',input.savedDraftRevision,version);
  await db.query('INSERT INTO digital_production_commands(actor_id,command,key,payload_hash,response) VALUES($1,$2,$3,$4,$5)',[actor.actorId,command,key,hash,JSON.stringify(result)]);return result;
 },true);}
 private async technical(db:PoolClient,actor:TrustedActorContext,write=false){
  if(isRootActor(actor))return;const p=new DigitalProductionAccessPolicy(db);
  for(const role of ['pattern_room_worker','pattern_room_supervisor'])if(actor.actorRoles.includes(role)&&await(write?p.lockActiveRole(actor.actorId,role):p.activeRole(actor.actorId,role)))return;
  digitalForbidden();
 }
 async templates(actor:TrustedActorContext,customerCode?:string){return this.transaction(async db=>{await this.technical(db,actor);return {items:(await db.query(`SELECT DISTINCT ON(template_id) template_id AS "templateId",version,customer_code AS "customerCode",body,created_at AS "createdAt" FROM digital_development_technical_templates WHERE ($1::text IS NULL OR customer_code=$1) ORDER BY template_id,version DESC LIMIT 100`,[customerCode??null])).rows};});}
 async templateVersion(actor:TrustedActorContext,templateId:string,version:number){return this.transaction(async db=>{
  await this.technical(db,actor);
  return (await db.query('SELECT template_id AS "templateId",version,customer_code AS "customerCode",body,created_at AS "createdAt" FROM digital_development_technical_templates WHERE template_id=$1 AND version=$2',[templateId,version])).rows[0]??digitalNotFound();
 });}
 async saveTemplate(actor:TrustedActorContext,raw:unknown,key:string){const input=SaveTechnicalTemplateSchema.parse(raw);if(!this.enabled)digitalForbidden();if(!/^[A-Za-z0-9._:-]{1,128}$/.test(key))conflict('缺少操作标识');return this.transaction(async db=>{
  await this.technical(db,actor,true);
  const hash=createHash('sha256').update(JSON.stringify(input)).digest('hex'),command=`development-size-template:${input.templateId}`;
  const prior=(await db.query('SELECT payload_hash,response FROM digital_production_commands WHERE actor_id=$1 AND command=$2 AND key=$3',[actor.actorId,command,key])).rows[0];
  if(prior){if(prior.payload_hash!==hash)conflict('模板操作标识已用于不同内容');return prior.response;}
  const issues=technicalSizeTableIssues(input.body.table);
  if(issues.length)conflict(issues.join('；'));
  if(input.body.table.templateRef)conflict('客户模板应保存自己的尺寸规则，不嵌套引用另一模板');
  if(!(await db.query('SELECT 1 FROM digital_production_customers WHERE code=$1 AND enabled',[input.body.customerCode])).rowCount)conflict('请选择本系统有效客户');
  const old=(await db.query('SELECT * FROM digital_development_technical_templates WHERE template_id=$1 ORDER BY version DESC LIMIT 1',[input.templateId])).rows[0];
  if((old?.version??0)!==input.expectedVersion)conflict('客户尺寸模板已有新版本');
  if(old&&old.customer_code!==input.body.customerCode)conflict('不能把已有模板改挂其它客户，请另建模板');
  const version=input.expectedVersion+1;
  await db.query('INSERT INTO digital_development_technical_templates(template_id,version,customer_code,body,reason,created_by,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[input.templateId,version,input.body.customerCode,JSON.stringify(input.body),input.reason,actor.actorId,businessNow().toISOString()]);
  const result={templateId:input.templateId,version};await db.query('INSERT INTO digital_production_commands(actor_id,command,key,payload_hash,response) VALUES($1,$2,$3,$4,$5)',[actor.actorId,command,key,hash,JSON.stringify(result)]);return result;
 },true);}
}
