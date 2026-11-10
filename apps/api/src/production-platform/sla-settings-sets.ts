import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import type {Pool,PoolClient} from 'pg';
import {z} from 'zod';
import {DIGITAL_SLA_PARAMETERS,validateDigitalSlaValues} from '@dx-rework/contracts/digital-sla';
import {DevelopmentCycleValuesSchema} from '@dx-rework/contracts/digital-development-technical';
import {validateSettingsSetValues,SettingsSetSaveSchema,SettingsSetBasisSchema,SettingsSetDraftSchema,SettingsSetPublishSchema,SettingsSetRestoreSchema,SettingsPlanningSchema,type SettingsSetBasis,type SettingsSetDraft,type SettingsSetRead,type SettingsSetValues,type SettingsSetRecord} from '@dx-rework/contracts/sla-settings-sets';
import type {TrustedActorContext} from '../tools/repositories.js';
import {ApplicationError} from '../platform/errors.js';
import {acceptanceBusinessContext} from '../acceptance-clock/business-time.js';
import {assertSlaSettingsActor,assertSlaSettingsReadActor} from './sla-settings-authority.js';
import {SlaConfigurationRepository} from './sla-configuration-repository.js';
import {latest,lockOwn,append,consumeSavedSettingsDraft,type DraftRow} from './sla-settings-drafts.js';
import {appendCurrentSettingsSet,latestSettingsSet,lockSettingsStandards,settingsSetRecord} from './sla-settings-set-repository.js';
import {SlaPreviewTokens} from './sla-preview-token.js';
import {copiedHistoryValues} from '@dx-rework/contracts/sla-settings-history';
const conflict=(message:string):never=>{throw new ApplicationError('SLA_SETTINGS_SET_CONFLICT',message,409);};
const digest=(v:unknown):string=>createHash('sha256').update(JSON.stringify(v,(_key,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.entries(x).sort(([a],[b])=>a<b?-1:a>b?1:0)):x)).digest('hex');
type Context={setVersion:number;planning:SettingsSetValues['planning'];sourceSetId?:string|null;partialRestore?:boolean};
const context=(row:DraftRow|null):Context|null=>row?.set_context_json as Context|null??null;
/** Original standards and personal append-only drafts, one transaction and one
 * published pair. Never applies a configuration to a running order. */
export class SlaSettingsSetsService{
 private readonly tokens:SlaPreviewTokens;
 constructor(private readonly database:Pool,secret?:string){this.tokens=new SlaPreviewTokens(secret);}
 private async transaction<T>(write:boolean,work:(db:PoolClient)=>Promise<T>){const db=await this.database.connect();try{
  await db.query(write?'BEGIN':'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  if(write)await db.query("SELECT pg_advisory_xact_lock(hashtextextended('digital-production-task-lifecycle-v1',0))");
  const result=await work(db);await db.query('COMMIT');return result;
 }catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}}
 private async state(db:PoolClient,actor:TrustedActorContext,includeDrafts=true):Promise<SettingsSetRead>{
  const repo=new SlaConfigurationRepository(db),unified=await repo.current(),development=(await db.query('SELECT version,values_json FROM digital_development_cycle_standards ORDER BY version DESC LIMIT 1')).rows[0];
  if(!development)throw new ApplicationError('NOT_FOUND','开发周期标准尚未安装',404);
  const set=await latestSettingsSet(db),u=includeDrafts?await latest(db,actor.actorId,'unified'):null,d=includeDrafts?await latest(db,actor.actorId,'development'):null;
  const current:SettingsSetValues={unified:unified?.values??await repo.bootstrapValues(),development:DevelopmentCycleValuesSchema.parse(development.values_json),planning:set?.planning??{}};
  const basis={unifiedVersion:unified?.version??0,developmentVersion:Number(development.version),setVersion:set?.version??0,unifiedDraftRevision:u?.revision??0,developmentDraftRevision:d?.revision??0};
  const us=u?.state==='saved'?u:null,ds=d?.state==='saved'?d:null,ctx=context(us)??context(ds);
  const developmentHistory=(await db.query('SELECT version,reason FROM digital_development_cycle_standards ORDER BY version DESC LIMIT 30')).rows as Array<{version:number;reason:string}>;
  return {developmentHistory,basis,current,set,draft:us||ds?{values:{unified:us?validateDigitalSlaValues(us.values_json):current.unified,development:ds?DevelopmentCycleValuesSchema.parse(ds.values_json):current.development,planning:ctx?.planning??current.planning},reason:us?.reason??ds?.reason??'',partialRestore:ctx?.partialRestore??false,
   basis:{...basis,unifiedVersion:us?.basis_version??basis.unifiedVersion,developmentVersion:ds?.basis_version??basis.developmentVersion,setVersion:ctx?.setVersion??basis.setVersion},
   baseline:{unified:us?validateDigitalSlaValues(us.basis_values_json):current.unified,development:ds?DevelopmentCycleValuesSchema.parse(ds.basis_values_json):current.development,planning:current.planning},
  }:null};
 }
 private async lock(db:PoolClient,actor:TrustedActorContext){await lockSettingsStandards(db);await lockOwn(db,actor.actorId,'unified');await lockOwn(db,actor.actorId,'development');}
 private assertBasis(state:SettingsSetRead,basis:SettingsSetBasis){if(!isDeepStrictEqual(state.basis,basis))conflict('现行标准或另一窗口草稿已更新，你的输入已保留，请重新核对');}
 private async receipt<T>(db:PoolClient,actor:TrustedActorContext,action:string,key:string,input:unknown,work:()=>Promise<T>):Promise<T>{
  z.uuid().parse(key);const command=`sla-settings-set:${action}`,hash=digest(input),prior=(await db.query('SELECT payload_hash,response FROM digital_production_commands WHERE actor_id=$1 AND command=$2 AND key=$3',[actor.actorId,command,key])).rows[0];
  if(prior){if(prior.payload_hash!==hash)conflict('原操作标识不能用于不同的内容');return prior.response as T;}
  const result=await work();await db.query('INSERT INTO digital_production_commands(actor_id,command,key,payload_hash,response) VALUES($1,$2,$3,$4,$5)',[actor.actorId,command,key,hash,JSON.stringify(result)]);return result;
 }
 private checked(raw:unknown,allowEmptyReason=false){try{const input=(allowEmptyReason?SettingsSetSaveSchema:SettingsSetDraftSchema).parse(raw);input.values=validateSettingsSetValues(input.values);return input;}catch(e){throw new ApplicationError('VALIDATION_ERROR',e instanceof Error?e.message:'请核对设置数值',400);}}
 async read(actor:TrustedActorContext){return this.transaction(false,async db=>{
  await assertSlaSettingsReadActor(db,actor);let includeDrafts=true;
  try{await assertSlaSettingsActor(db,actor);}catch(e){if(e instanceof ApplicationError&&e.statusCode===403)includeDrafts=false;else throw e;}
  // PMC reads published standards/history, never a prior manager's unpublished
  // personal draft after that management role was actually revoked.
  return this.state(db,actor,includeDrafts);
 });}
 private async appendDraft(db:PoolClient,actor:TrustedActorContext,input:SettingsSetDraft,state:SettingsSetRead,ctx:Context){
  for(const group of ['unified','development'] as const)await append(db,actor.actorId,group,{revision:state.basis[group==='unified'?'unifiedDraftRevision':'developmentDraftRevision']+1,basis:state.basis[group==='unified'?'unifiedVersion':'developmentVersion'],values:input.values[group],baseline:state.current[group],reason:input.reason,state:'saved',setContext:ctx});
  return this.state(db,actor);
 }
 async save(actor:TrustedActorContext,raw:unknown,key:string){const input=this.checked(raw,true);return this.transaction(true,async db=>{
  await assertSlaSettingsActor(db,actor,true);await this.lock(db,actor);return this.receipt(db,actor,'save',key,input,async()=>{const state=await this.state(db,actor);this.assertBasis(state,SettingsSetBasisSchema.strip().parse(input));
   const previous=context(await latest(db,actor.actorId,'unified'));
   return this.appendDraft(db,actor,input,state,{setVersion:state.basis.setVersion,planning:input.values.planning,...(previous?.sourceSetId?{sourceSetId:previous.sourceSetId}:{}),partialRestore:previous?.partialRestore??false});
  });
 });}
 async discard(actor:TrustedActorContext,raw:unknown,key:string){const basis=SettingsSetBasisSchema.parse(raw);return this.transaction(true,async db=>{
  await assertSlaSettingsActor(db,actor,true);await this.lock(db,actor);return this.receipt(db,actor,'discard',key,basis,async()=>{const state=await this.state(db,actor);this.assertBasis(state,basis);
   for(const group of ['unified','development'] as const)await append(db,actor.actorId,group,{revision:basis[group==='unified'?'unifiedDraftRevision':'developmentDraftRevision']+1,basis:basis[group==='unified'?'unifiedVersion':'developmentVersion'],values:{},baseline:{},reason:'用户明确丢弃本次组合草稿',state:'discarded'});
   return this.state(db,actor);
  });
 });}
 private changes(state:SettingsSetRead,input:SettingsSetDraft){
  const changes:Array<{label:string;before:unknown;after:unknown}>=[],cycleLabels={normalDays:'普通开发周期（天）',urgentDays:'批准加急周期（天）',sizeReviewHours:'尺寸复核（小时）',externalWashDays:'外洗周期（天）'};
  for(const p of DIGITAL_SLA_PARAMETERS)if(!isDeepStrictEqual(state.current.unified[p.key],input.values.unified[p.key]))changes.push({label:p.label,before:state.current.unified[p.key],after:input.values.unified[p.key]});
  for(const key of Object.keys(input.values.development) as Array<keyof SettingsSetValues['development']>)if(state.current.development[key]!==input.values.development[key])changes.push({label:cycleLabels[key],before:state.current.development[key],after:input.values.development[key]});
  for(const key of new Set([...Object.keys(state.current.planning),...Object.keys(input.values.planning)]))if(!isDeepStrictEqual(state.current.planning[key as keyof typeof state.current.planning],input.values.planning[key as keyof typeof input.values.planning]))changes.push({label:`${DIGITAL_SLA_PARAMETERS.find(p=>p.key===key)?.label??(key==='factory_production_work'?'工厂生产':key==='development_positioning'?'开发定位资料':key)}规划`,before:state.current.planning[key as keyof typeof state.current.planning]??null,after:input.values.planning[key as keyof typeof input.values.planning]??null});
  return changes;
 }
 private assertSaved(state:SettingsSetRead,input:SettingsSetDraft){if(!state.draft||!isDeepStrictEqual(state.draft.values,input.values)||state.draft.reason!==input.reason||!isDeepStrictEqual(state.draft.basis,state.basis))conflict('请先保存当前组合草稿，再预览发布');}
 async preview(actor:TrustedActorContext,raw:unknown){const input=this.checked(raw);return this.transaction(false,async db=>{
  await assertSlaSettingsActor(db,actor);const state=await this.state(db,actor);this.assertBasis(state,SettingsSetBasisSchema.strip().parse(input));this.assertSaved(state,input);const changes=this.changes(state,input);
  if(!changes.length&&state.set)conflict('没有需要发布的变化');return {token:this.tokens.issue(digest([actor.actorId,input])),changes,existingOrdersChanged:0};
 });}
 async publish(actor:TrustedActorContext,raw:unknown,key:string){const parsed=SettingsSetPublishSchema.parse(raw),{previewToken,...draft}=parsed,input=this.checked(draft);return this.transaction(true,async db=>{
  await assertSlaSettingsActor(db,actor,true);if(acceptanceBusinessContext())conflict('测试时钟场景不能发布全局标准');await this.lock(db,actor);
  return this.receipt(db,actor,'publish',key,parsed,async()=>{
   const state=await this.state(db,actor);this.assertBasis(state,SettingsSetBasisSchema.strip().parse(input));this.assertSaved(state,input);this.tokens.verify(previewToken,digest([actor.actorId,input]));
   if(!this.changes(state,input).length&&state.set)conflict('没有需要发布的变化');
   let unifiedVersion=state.basis.unifiedVersion;
   if(!unifiedVersion||!isDeepStrictEqual(state.current.unified,input.values.unified))unifiedVersion=(await new SlaConfigurationRepository(db).publish({expectedVersion:unifiedVersion,values:input.values.unified,actorId:actor.actorId,reason:input.reason,requestKey:key})).version;
   let developmentVersion=state.basis.developmentVersion;
   if(!isDeepStrictEqual(state.current.development,input.values.development)){
    developmentVersion++;await db.query('INSERT INTO digital_development_cycle_standards(version,values_json,changed_by,reason) VALUES($1,$2,$3,$4)',[developmentVersion,JSON.stringify(input.values.development),actor.actorId,input.reason]);
   }
   const ctx=context(await latest(db,actor.actorId,'unified')),set=await appendCurrentSettingsSet(db,actor.actorId,key,{planning:input.values.planning,reason:input.reason,sourceSetId:ctx?.sourceSetId??null});
   if(!set)throw Error('组合标准未生成');
   await consumeSavedSettingsDraft(db,actor,'unified',input.unifiedDraftRevision,unifiedVersion);await consumeSavedSettingsDraft(db,actor,'development',input.developmentDraftRevision,developmentVersion);
   return {set,existingOrdersChanged:0};
  });
 });}
 async history(actor:TrustedActorContext,page=1){z.number().int().min(1).max(100000).parse(page);return this.transaction(false,async db=>{
  await assertSlaSettingsReadActor(db,actor);
  const sql=`WITH history AS (
   SELECT s.standard_id AS set_id,s.version,c.version AS unified_version,s.development_version,s.reason,s.recorded_at,false AS partial
    FROM digital_timeline_standard_versions s JOIN digital_sla_configurations c ON c.configuration_id=s.unified_configuration_id
   UNION ALL SELECT NULL::uuid,NULL::int,c.version,NULL::int,c.reason,c.created_at,true FROM digital_sla_configurations c
    WHERE NOT EXISTS(SELECT 1 FROM digital_timeline_standard_versions s WHERE s.unified_configuration_id=c.configuration_id))`;
  const totalCount=Number((await db.query(sql+' SELECT count(*) AS count FROM history')).rows[0].count),rows=(await db.query(sql+' SELECT * FROM history ORDER BY recorded_at DESC,unified_version DESC,version DESC NULLS LAST LIMIT 15 OFFSET $1',[(page-1)*15])).rows;
  return {items:rows.map(r=>({setId:r.set_id,version:r.version,unifiedVersion:r.unified_version,developmentVersion:r.development_version,reason:r.reason,recordedAt:new Date(r.recorded_at).toISOString(),partial:r.partial})),page,pageSize:15 as const,totalCount};
 });}
 async historyValues(actor:TrustedActorContext,source:{setId:string|null;unifiedSourceVersion:number|null}){return this.transaction(false,async db=>{await assertSlaSettingsReadActor(db,actor);return this.sourceValues(db,source);});}
 private async sourceValues(db:PoolClient,source:{setId:string|null;unifiedSourceVersion:number|null}):Promise<{values:Partial<SettingsSetValues>;set:SettingsSetRecord|null;partial:boolean}>{
  if(source.setId){const row=(await db.query('SELECT s.*,c.version AS unified_version FROM digital_timeline_standard_versions s JOIN digital_sla_configurations c ON c.configuration_id=s.unified_configuration_id WHERE s.standard_id=$1',[source.setId])).rows[0];
   if(!row)throw new ApplicationError('NOT_FOUND','组合历史不存在',404);const set=settingsSetRecord(row),unified=await new SlaConfigurationRepository(db).current(set.unifiedVersion),development=(await db.query('SELECT values_json FROM digital_development_cycle_standards WHERE version=$1',[set.developmentVersion])).rows[0];
   if(!unified||!development)throw Error('原组合标准引用缺失');return {values:{unified:unified.values,development:DevelopmentCycleValuesSchema.parse(development.values_json),planning:SettingsPlanningSchema.parse(set.planning)},set,partial:false};
  }
  if(!source.unifiedSourceVersion)throw new ApplicationError('VALIDATION_ERROR','请选择历史版本',400);
  const unified=await new SlaConfigurationRepository(db).current(source.unifiedSourceVersion);if(!unified)throw new ApplicationError('NOT_FOUND','原时效历史不存在',404);
  return {values:{unified:unified.values},set:null,partial:true};
 }
 async restore(actor:TrustedActorContext,raw:unknown,key:string){const input=SettingsSetRestoreSchema.parse(raw);return this.transaction(true,async db=>{
  await assertSlaSettingsActor(db,actor,true);await this.lock(db,actor);return this.receipt(db,actor,'restore',key,input,async()=>{
   const state=await this.state(db,actor);this.assertBasis(state,SettingsSetBasisSchema.strip().parse(input));const source=await this.sourceValues(db,input),retained=state.draft?.values??state.current;
   const values:SettingsSetValues={unified:copiedHistoryValues(source.values.unified!,state.current.unified),development:source.values.development??retained.development,planning:source.values.planning??retained.planning};
   return this.appendDraft(db,actor,{...state.basis,values,reason:source.partial?'仅恢复已保存部分':'从组合历史恢复草稿'},state,{setVersion:state.basis.setVersion,planning:values.planning,sourceSetId:source.set?.setId??null,partialRestore:source.partial});
  });
 });}
}
