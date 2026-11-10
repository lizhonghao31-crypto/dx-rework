import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import type {Pool,PoolClient} from 'pg';
import {z} from 'zod';
import {validateDigitalSlaValues} from '@dx-rework/contracts/digital-sla';
import {DevelopmentCycleValuesSchema} from '@dx-rework/contracts/digital-development-technical';
import {SlaDraftSaveSchema,SlaDraftDiscardSchema,type SlaDraftSave,type SlaDraftGroup,type SlaSavedDraft,type SlaDraftEnvelope,type SlaDraftSavedReply,type SlaDraftDiscardedReply} from '@dx-rework/contracts/sla-settings-drafts';
import type {TrustedActorContext} from '../tools/repositories.js';
import {ApplicationError} from '../platform/errors.js';
import {assertSlaSettingsActor} from './sla-settings-authority.js';
import {SlaConfigurationRepository} from './sla-configuration-repository.js';
import {SlaCopyVersionSchema,copiedHistoryValues} from '@dx-rework/contracts/sla-settings-history';
import {readSlaPolicyValuesMany} from './sla-policy-values.js';

export type DraftRow={actor_id:string;standard_group:SlaDraftGroup;revision:number;basis_version:number;source_version?:number|null;set_context_json?:unknown;values_json:unknown;basis_values_json:unknown;reason:string;state:'saved'|'discarded'|'published';created_at:Date|string};
const conflict=(message:string):never=>{throw new ApplicationError('SLA_DRAFT_CONFLICT',message,409);};
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b,'en'))):item)).digest('hex');
const values=(group:SlaDraftGroup,value:unknown)=>group==='unified'?validateDigitalSlaValues(value):DevelopmentCycleValuesSchema.parse(value);
export const latest=async(db:PoolClient,actorId:string,group:SlaDraftGroup):Promise<DraftRow|null>=>(await db.query<DraftRow>('SELECT * FROM digital_sla_settings_drafts WHERE actor_id=$1 AND standard_group=$2 ORDER BY revision DESC LIMIT 1',[actorId,group])).rows[0]??null;
const version=async(db:PoolClient,group:SlaDraftGroup):Promise<number>=>Number((await db.query(group==='unified'?'SELECT version FROM digital_sla_configurations ORDER BY version DESC LIMIT 1':'SELECT version FROM digital_development_cycle_standards ORDER BY version DESC LIMIT 1')).rows[0]?.version??0);
export const lockOwn=async(db:PoolClient,actorId:string,group:SlaDraftGroup)=>{await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`sla-settings-draft:${actorId}:${group}`]);};
function saved(row:DraftRow):SlaSavedDraft{
 const base={revision:row.revision,expectedVersion:row.basis_version,reason:row.reason,savedAt:new Date(row.created_at).toISOString()};
 return row.standard_group==='unified'?{...base,group:'unified',...(row.source_version?{sourceVersion:row.source_version??null}:{}),values:validateDigitalSlaValues(row.values_json),baselineValues:validateDigitalSlaValues(row.basis_values_json)}:{...base,group:'development',values:DevelopmentCycleValuesSchema.parse(row.values_json),baselineValues:DevelopmentCycleValuesSchema.parse(row.basis_values_json)};
}
export async function envelope(db:PoolClient,actorId:string,group:SlaDraftGroup):Promise<SlaDraftEnvelope>{const row=await latest(db,actorId,group);return {group,currentStandardVersion:await version(db,group),revision:row?.revision??0,draft:row?.state==='saved'?saved(row):null};}
export async function append(db:PoolClient,actorId:string,group:SlaDraftGroup,input:{revision:number;basis:number;values:unknown;baseline:unknown;reason:string;state:DraftRow['state'];publishedVersion?:number;sourceVersion?:number|null;setContext?:unknown}){
 return (await db.query<DraftRow>(`INSERT INTO digital_sla_settings_drafts(actor_id,standard_group,revision,basis_version,values_json,basis_values_json,reason,state,published_version,source_version,set_context_json)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,[actorId,group,input.revision,input.basis,JSON.stringify(input.values),JSON.stringify(input.baseline),input.reason,input.state,input.publishedVersion??null,input.sourceVersion??null,input.setContext?JSON.stringify(input.setContext):null])).rows[0]!;
}
/** Same publication transaction, after its original standard lock/authority check.
 * Taking the policy-table lock before the personal lock avoids lock inversion. */
export async function assertSavedSettingsDraft(db:PoolClient,actor:TrustedActorContext,group:SlaDraftGroup,revision:number,input:{expectedVersion:number;values:unknown;reason:string}){
 await lockOwn(db,actor.actorId,group);const row=await latest(db,actor.actorId,group);
 if(!row||row.state!=='saved'||row.revision!==revision||row.basis_version!==input.expectedVersion||row.reason!==input.reason.trim()||!isDeepStrictEqual(values(group,row.values_json),values(group,input.values)))conflict('已保存草稿已变化，请重新读取并保存后发布');
}
export async function consumeSavedSettingsDraft(db:PoolClient,actor:TrustedActorContext,group:SlaDraftGroup,revision:number,publishedVersion:number){
 const row=await latest(db,actor.actorId,group);if(!row||row.state!=='saved'||row.revision!==revision)return conflict('草稿发布回执的版本已变化');
 await append(db,actor.actorId,group,{revision:revision+1,basis:row.basis_version,values:row.values_json,baseline:row.basis_values_json,reason:row.reason,state:'published',publishedVersion,sourceVersion:row.source_version??null});
}
/** A retry may refer to an older publication while another browser has saved a
 * newer personal draft. Check its original receipt, never consume the newer row. */
export async function assertSavedSettingsReplay(db:PoolClient,actor:TrustedActorContext,group:SlaDraftGroup,revision:number|undefined,publishedVersion:number){
 if(!(await db.query("SELECT to_regclass('digital_sla_settings_drafts') AS relation")).rows[0]?.relation){if(revision!==undefined)conflict('当前安装尚不支持持久草稿');return;}
 const row=(await db.query('SELECT revision FROM digital_sla_settings_drafts WHERE actor_id=$1 AND standard_group=$2 AND published_version=$3 AND state=\'published\'',[actor.actorId,group,publishedVersion])).rows[0];
 if(row?revision!==row.revision-1:revision!==undefined)conflict('原发布标识不能用于不同的已保存草稿');
}

/** Own small settings transactions; reads/saves do not acquire the global task
 * lifecycle lock, run order calculations, or initialize published standards. */
export class SlaSettingsDraftService{
 constructor(private readonly database:Pool){}
 private async transaction<T>(write:boolean,work:(db:PoolClient)=>Promise<T>){const db=await this.database.connect();try{await db.query(write?'BEGIN':'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');const result=await work(db);await db.query('COMMIT');return result;}catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}}
 async read(actor:TrustedActorContext,group:SlaDraftGroup){return this.transaction(false,async db=>{await assertSlaSettingsActor(db,actor);return envelope(db,actor.actorId,group);});}
 async save(actor:TrustedActorContext,raw:unknown,key:string):Promise<SlaDraftSavedReply>{
  const input:SlaDraftSave=SlaDraftSaveSchema.parse(raw);z.string().uuid().parse(key);let checked;try{checked=values(input.group,input.values);}catch{throw new ApplicationError('VALIDATION_ERROR','请检查草稿的时长、单位、比例及内含目标',400);}const hash=digest({action:'save',...input,values:checked}),command=`sla-settings-draft:${input.group}`;
  return this.transaction(true,async db=>{
   await assertSlaSettingsActor(db,actor,true);
   // Shared readers may save concurrently; only a real policy publication waits.
   await db.query(input.group==='unified'?'LOCK TABLE digital_sla_configurations IN SHARE MODE':'LOCK TABLE digital_development_cycle_standards IN SHARE MODE');
   await lockOwn(db,actor.actorId,input.group);
   const prior=(await db.query('SELECT payload_hash,response FROM digital_production_commands WHERE actor_id=$1 AND command=$2 AND key=$3',[actor.actorId,command,key])).rows[0];
   const head=await latest(db,actor.actorId,input.group),currentVersion=await version(db,input.group);
   if(prior){if(prior.payload_hash!==hash)conflict('原草稿操作标识不能用于不同内容');const result=prior.response as {saved:SlaSavedDraft};return {saved:result.saved,currentRevision:head?.revision??0,currentStandardVersion:currentVersion,superseded:head?.revision!==result.saved.revision};}
   if((head?.revision??0)!==input.expectedDraftRevision)conflict('另一窗口已保存新草稿，你的输入已保留，请重新读取');
   if(currentVersion!==input.expectedVersion)conflict('现行标准已更新，你的输入已保留，请核对新值后保存草稿');
   // Store the actual original baseline, including unpublished version0. It
   // allows refresh/conflict recovery to retain only the user's changed fields.
   const repository=new SlaConfigurationRepository(db),baseline=input.group==='unified'?(await repository.current())?.values??await repository.bootstrapValues():DevelopmentCycleValuesSchema.parse((await db.query('SELECT values_json FROM digital_development_cycle_standards ORDER BY version DESC LIMIT 1')).rows[0]?.values_json);
   const row=await append(db,actor.actorId,input.group,{revision:input.expectedDraftRevision+1,basis:input.expectedVersion,values:checked,baseline,reason:input.reason,state:'saved',sourceVersion:head?.state==='saved'?head.source_version??null:null}),result={saved:saved(row),currentRevision:row.revision,currentStandardVersion:currentVersion,superseded:false};
   await db.query('INSERT INTO digital_production_commands(actor_id,command,key,payload_hash,response) VALUES($1,$2,$3,$4,$5)',[actor.actorId,command,key,hash,JSON.stringify(result)]);return result;
  });
 }
 async copyVersion(actor:TrustedActorContext,raw:unknown,key:string):Promise<SlaDraftSavedReply>{
  const input=SlaCopyVersionSchema.parse(raw);z.string().uuid().parse(key);const command='sla-settings-draft:unified',hash=digest({action:'copy-version',...input});
  return this.transaction(true,async db=>{
   await assertSlaSettingsActor(db,actor,true);await db.query('LOCK TABLE digital_sla_configurations IN SHARE MODE');await lockOwn(db,actor.actorId,'unified');
   const prior=(await db.query('SELECT payload_hash,response FROM digital_production_commands WHERE actor_id=$1 AND command=$2 AND key=$3',[actor.actorId,command,key])).rows[0],head=await latest(db,actor.actorId,'unified'),currentVersion=await version(db,'unified');
   if(prior){if(prior.payload_hash!==hash)conflict('原复制标识不能用于不同版本或内容');const result=prior.response as {saved:SlaSavedDraft};return {saved:result.saved,currentRevision:head?.revision??0,currentStandardVersion:currentVersion,superseded:head?.revision!==result.saved.revision};}
   if((head?.revision??0)!==input.expectedDraftRevision)conflict('另一窗口已修改个人草稿，未覆盖；请重新读取后核对');
   if(currentVersion!==input.expectedVersion)conflict('现行标准已更新，未覆盖个人草稿；请核对新版本后复制');
   const rows=(await db.query('SELECT * FROM digital_sla_configurations WHERE version=$1 OR version=$2 ORDER BY version DESC',[currentVersion,input.sourceVersion])).rows,original=rows.find(row=>row.version===input.sourceVersion),current=rows.find(row=>row.version===currentVersion);
   if(!original||!current)throw new ApplicationError('NOT_FOUND','来源标准版本不存在，未复制',404);
   const all=await readSlaPolicyValuesMany(db,rows.map(row=>row.policy_refs_json??row.values_json)),baseline=all[rows.indexOf(current)]!,values=copiedHistoryValues(all[rows.indexOf(original)]!,baseline),row=await append(db,actor.actorId,'unified',{revision:input.expectedDraftRevision+1,basis:currentVersion,values,baseline,reason:`从已发布 v${input.sourceVersion} 复制的草稿`,state:'saved',sourceVersion:input.sourceVersion}),result={saved:saved(row),currentRevision:row.revision,currentStandardVersion:currentVersion,superseded:false};
   await db.query('INSERT INTO digital_production_commands(actor_id,command,key,payload_hash,response) VALUES($1,$2,$3,$4,$5)',[actor.actorId,command,key,hash,JSON.stringify(result)]);return result;
  });
 }
 async discard(actor:TrustedActorContext,raw:unknown,key:string):Promise<SlaDraftDiscardedReply>{
  const input=SlaDraftDiscardSchema.parse(raw);z.string().uuid().parse(key);const command=`sla-settings-draft:${input.group}`,hash=digest({action:'discard',...input});
  return this.transaction(true,async db=>{
   await assertSlaSettingsActor(db,actor,true);await lockOwn(db,actor.actorId,input.group);
   const prior=(await db.query('SELECT payload_hash,response FROM digital_production_commands WHERE actor_id=$1 AND command=$2 AND key=$3',[actor.actorId,command,key])).rows[0];
   if(prior){if(prior.payload_hash!==hash)conflict('原草稿操作标识不能用于不同内容');const current=await envelope(db,actor.actorId,input.group),discardedRevision=Number(prior.response.discardedRevision);return {...current,discardedRevision,superseded:current.revision!==discardedRevision};}
   const head=await latest(db,actor.actorId,input.group);if((head?.revision??0)!==input.expectedDraftRevision)conflict('另一窗口已保存新草稿，未丢弃其修改');
   const currentVersion=await version(db,input.group);await append(db,actor.actorId,input.group,{revision:input.expectedDraftRevision+1,basis:currentVersion,values:{},baseline:{},reason:'用户明确丢弃草稿',state:'discarded'});
   const result={...await envelope(db,actor.actorId,input.group),discardedRevision:input.expectedDraftRevision+1,superseded:false};await db.query('INSERT INTO digital_production_commands(actor_id,command,key,payload_hash,response) VALUES($1,$2,$3,$4,$5)',[actor.actorId,command,key,hash,JSON.stringify(result)]);return result;
  });
 }
}
